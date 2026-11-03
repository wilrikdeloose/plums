import { TransportError, type HttpResponse, type HttpTransport } from "../platform";
import { SseParser } from "./sse";

export interface ChatToolFunctionSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatToolSpec {
  type: "function";
  function: ChatToolFunctionSpec;
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type ChatMessageParam =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ChatToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

export type AiErrorKind =
  | "config"
  | "missing-key"
  | "auth"
  | "forbidden"
  | "not-found"
  | "rate-limit"
  | "bad-request"
  | "tool-unsupported"
  | "server"
  | "network"
  | "timeout"
  | "stream"
  | "bad-response"
  | "aborted";

export class AiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}

export interface ChatStreamResult {
  text: string;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  /** True once at least one well-formed completion chunk was received. */
  receivedValidChunk: boolean;
}

export interface ChatStreamOptions {
  transport: HttpTransport;
  url: string;
  model: string;
  messages: ChatMessageParam[];
  tools?: ChatToolSpec[];
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}

const MAX_ERROR_BODY = 8 * 1024;

/** Removes anything that looks like a credential from provider/transport text. */
export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [verborgen]")
    .replace(/\b(sk|pk|rk|key|api|gsk|xai)[-_][A-Za-z0-9_\-*.]{6,}/gi, "[verborgen]")
    .replace(/[A-Za-z0-9_\-]{32,}/g, "[verborgen]");
}

async function readLimited(response: HttpResponse, signal?: AbortSignal): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of response.body) {
    if (signal?.aborted) break;
    text += decoder.decode(chunk, { stream: true });
    if (text.length > MAX_ERROR_BODY) break;
  }
  return text + decoder.decode();
}

function providerMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const raw = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message;
    if (typeof raw === "string" && raw.trim()) return redactSecrets(raw.trim()).slice(0, 300);
  } catch {
    // not JSON
  }
  const plain = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return plain ? redactSecrets(plain).slice(0, 200) : "";
}

function httpError(status: number, headers: Record<string, string>, body: string, model: string): AiError {
  const detail = providerMessage(body);
  const suffix = detail ? ` Melding van de dienst: ${detail}` : "";
  const toolUnsupported =
    (status === 400 || status === 422 || status === 404 || status === 501) &&
    /(tool|function[ _-]?call|functions)/i.test(detail) &&
    /(not[ _-]?support|unsupported|does not support|not available|unknown field|unrecognized|invalid|cannot|niet ondersteund)/i.test(detail);
  if (toolUnsupported) {
    return new AiError(
      "tool-unsupported",
      `Het geconfigureerde model "${model}" ondersteunt geen tool-calling (functie-aanroepen) bij deze dienst (${status}). Canvas is daarom niet geraadpleegd.${suffix}`,
    );
  }
  const modelProblem = /model/i.test(detail) && /(not[ _]?found|does not exist|unknown|invalid|not available|unsupported)/i.test(detail);
  if (status === 401) return new AiError("auth", `De API-sleutel is ongeldig, verlopen of hoort niet bij dit endpoint (401).${suffix}`);
  if (status === 403) return new AiError("forbidden", `Geen toegang tot dit endpoint of model (403).${suffix}`);
  if (status === 404 || modelProblem) {
    return new AiError(
      "not-found",
      modelProblem
        ? `Het model "${model}" is niet beschikbaar bij deze dienst (${status}). Controleer de model-slug.${suffix}`
        : `Endpoint of model niet gevonden (404). Controleer de basis-URL en de model-slug.${suffix}`,
    );
  }
  if (status === 429) {
    const retry = headers["retry-after"];
    const wait = retry && /^\d+$/.test(retry) ? ` Probeer het over ${retry} seconden opnieuw.` : " Probeer het later opnieuw.";
    return new AiError("rate-limit", `Te veel verzoeken of het tegoed is op (429).${wait}${suffix}`);
  }
  if (status === 408 || status === 504) return new AiError("timeout", `De AI-dienst reageerde niet op tijd (${status}).${suffix}`);
  if (status >= 500) return new AiError("server", `De AI-dienst heeft een storing (${status}). Probeer het later opnieuw.${suffix}`);
  if (status === 400 || status === 422) return new AiError("bad-request", `De AI-dienst weigerde het verzoek (${status}).${suffix}`);
  return new AiError("bad-response", `Onverwacht antwoord van de AI-dienst (HTTP ${status}).${suffix}`);
}

function transportError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  if (error instanceof TransportError) {
    const message = redactSecrets(error.message);
    switch (error.kind) {
      case "aborted":
        return new AiError("aborted", "Gestopt.");
      case "missing-secret":
        return new AiError("missing-key", message);
      case "timeout":
        return new AiError("timeout", message);
      case "stream":
        return new AiError("stream", message);
      case "invalid-request":
        return new AiError("config", message);
      default:
        return new AiError("network", message);
    }
  }
  if (error instanceof DOMException && error.name === "AbortError") return new AiError("aborted", "Gestopt.");
  return new AiError("network", redactSecrets(error instanceof Error ? error.message : String(error)));
}

interface StreamToolCallDelta {
  index?: unknown;
  id?: unknown;
  type?: unknown;
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
}

interface ChunkChoice {
  delta?: { content?: unknown; tool_calls?: unknown };
  message?: { content?: unknown; tool_calls?: unknown };
  finish_reason?: unknown;
}

interface ToolCallAccumulator {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

/**
 * Sends one streaming chat completion request and reports assistant text as it arrives.
 * Accumulates fragmented streamed `tool_calls` by index/ID, including split function names and JSON arguments.
 * Only `content` and `tool_calls` are used; provider reasoning fields (`reasoning`, `reasoning_content`, …) are ignored.
 */
export async function streamChatCompletion(options: ChatStreamOptions): Promise<ChatStreamResult> {
  const { transport, url, model, messages, tools, signal, onText } = options;
  const result: ChatStreamResult = {
    text: "",
    toolCalls: [],
    finishReason: null,
    receivedValidChunk: false,
  };
  const toolAccumulators = new Map<number, ToolCallAccumulator>();
  const idToIndex = new Map<string, number>();
  let nextSyntheticIndex = 0;
  let done = false;

  const mergeToolCallList = (rawList: unknown) => {
    if (!Array.isArray(rawList)) return;
    for (const item of rawList) {
      if (typeof item !== "object" || item === null) continue;
      const tc = item as StreamToolCallDelta;
      const rawId = typeof tc.id === "string" && tc.id.trim() ? tc.id.trim() : "";

      let index: number;
      if (typeof tc.index === "number" && Number.isInteger(tc.index) && tc.index >= 0) {
        index = tc.index;
      } else if (rawId && idToIndex.has(rawId)) {
        index = idToIndex.get(rawId)!;
      } else if (rawId) {
        index = nextSyntheticIndex++;
      } else if (toolAccumulators.size > 0) {
        // Fallback to the most recently active index if neither index nor id was sent on a continuation delta
        index = Math.max(...toolAccumulators.keys());
      } else {
        index = 0;
      }

      if (rawId) {
        idToIndex.set(rawId, index);
      }
      if (index >= nextSyntheticIndex) {
        nextSyntheticIndex = index + 1;
      }

      let acc = toolAccumulators.get(index);
      if (!acc) {
        acc = { index, id: rawId, name: "", arguments: "" };
        toolAccumulators.set(index, acc);
      } else if (rawId && !acc.id) {
        acc.id = rawId;
      }

      if (tc.function && typeof tc.function === "object") {
        if (typeof tc.function.name === "string" && tc.function.name.length > 0) {
          // Non-streaming `message.tool_calls` sends the full name; streaming `delta.tool_calls` sends fragments
          acc.name += tc.function.name;
        }
        if (typeof tc.function.arguments === "string" && tc.function.arguments.length > 0) {
          acc.arguments += tc.function.arguments;
        }
      }
    }
  };

  const handleJson = (json: unknown) => {
    if (typeof json !== "object" || json === null) throw new AiError("bad-response", "De AI-dienst stuurde onleesbare gegevens.");
    const obj = json as { choices?: unknown; error?: { message?: unknown } };
    if (obj.error) {
      const msg = typeof obj.error.message === "string" ? redactSecrets(obj.error.message).slice(0, 300) : "onbekende fout";
      throw new AiError("stream", `De AI-dienst meldde een fout tijdens het antwoord: ${msg}`);
    }
    if (!Array.isArray(obj.choices)) return;
    result.receivedValidChunk = true;
    const choice = obj.choices[0] as ChunkChoice | undefined;
    if (!choice) return;
    const content = choice.delta?.content ?? choice.message?.content;
    if (typeof content === "string" && content.length > 0) {
      result.text += content;
      onText?.(content);
    }
    mergeToolCallList(choice.delta?.tool_calls ?? choice.message?.tool_calls);
    if (typeof choice.finish_reason === "string") result.finishReason = choice.finish_reason;
  };

  const finalizeToolCalls = () => {
    const sorted = [...toolAccumulators.values()].sort((a, b) => a.index - b.index);
    result.toolCalls = sorted.map((acc, idx) => ({
      id: acc.id || `call_${idx + 1}`,
      type: "function",
      function: {
        name: acc.name.trim(),
        arguments: acc.arguments.trim() || "{}",
      },
    }));
  };

  const requestBody: Record<string, unknown> = {
    model,
    messages,
    stream: true,
  };
  if (tools && tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = "auto";
  }

  let response: HttpResponse;
  try {
    response = await transport.request({
      url,
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(requestBody),
      bearerFromSecret: true,
      signal,
    });
  } catch (error) {
    throw transportError(error);
  }

  try {
    if (response.status < 200 || response.status >= 300) {
      throw httpError(response.status, response.headers, await readLimited(response, signal), model);
    }

    const contentType = response.headers["content-type"] ?? "";
    if (contentType.includes("application/json")) {
      const body = await readLimited(response, signal);
      try {
        handleJson(JSON.parse(body));
      } catch (error) {
        if (error instanceof AiError) throw error;
        throw new AiError("bad-response", "De AI-dienst stuurde onleesbare JSON.");
      }
      if (!result.receivedValidChunk) throw new AiError("bad-response", "Het antwoord bevat geen keuzes (choices).");
      finalizeToolCalls();
      return result;
    }

    const parser = new SseParser();
    const handleEvents = (events: { data: string }[]) => {
      for (const ev of events) {
        if (done) return;
        const data = ev.data.trim();
        if (data === "[DONE]") {
          done = true;
          return;
        }
        if (!data) continue;
        let json: unknown;
        try {
          json = JSON.parse(data);
        } catch {
          throw new AiError("bad-response", "De AI-dienst stuurde een onleesbaar stream-fragment.");
        }
        handleJson(json);
      }
    };
    for await (const chunk of response.body) {
      handleEvents(parser.push(chunk));
      if (done) break;
    }
    if (!done) handleEvents(parser.end());
  } catch (error) {
    throw transportError(error);
  }

  if (signal?.aborted) throw new AiError("aborted", "Gestopt.");
  if (!done && result.finishReason === null) {
    throw new AiError("stream", "De verbinding werd verbroken voordat het antwoord compleet was.");
  }
  if (!result.receivedValidChunk) throw new AiError("bad-response", "De AI-dienst stuurde geen geldig antwoord.");
  finalizeToolCalls();
  return result;
}

/** Small real request with the configured transport and model; succeeds only on a valid completion. */
export async function testConnection(transport: HttpTransport, url: string, model: string, signal?: AbortSignal): Promise<string> {
  const result = await streamChatCompletion({
    transport,
    url,
    model,
    signal,
    messages: [{ role: "user", content: "Dit is een verbindingstest. Antwoord alleen met: OK" }],
  });
  return result.text.trim().slice(0, 80);
}
