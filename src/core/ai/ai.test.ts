import { describe, expect, it } from "vitest";
import { addUserMessage, deleteConversation } from "../conversations";
import { DataController } from "../dataController";
import { CanvasService } from "../mcp/canvasService";
import { CANONICAL_TOOLS } from "../mcp/policy";
import type { McpClient, McpDiscoveryResult, McpTargetConfig, McpToolCallResult } from "../mcp/types";
import {
  type DataStore,
  type FileTransfer,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  type Platform,
  type SecretStore,
  type StorageInfo,
  TransportError,
} from "../platform";
import { createDefaultData, serializeAppData, validateAppData } from "../schema";
import { ChatRunner } from "./chatRunner";
import { AiError, redactSecrets, streamChatCompletion, testConnection } from "./client";
import { buildChatMessages, selectRelevantHistory } from "./context";
import { chatCompletionsUrl } from "./endpoint";
import { SseParser } from "./sse";
import { MemorySecretStore } from "../../web/memorySecretStore";
import { FetchTransport } from "../../web/fetchTransport";

class InMemoryDataStore implements DataStore {
  raw: unknown | null = null;

  async info(): Promise<StorageInfo> {
    return { type: "Geheugen", location: "memory" };
  }

  async load(): Promise<unknown | null> {
    return this.raw ? structuredClone(this.raw) : null;
  }

  async save(data: unknown): Promise<void> {
    this.raw = structuredClone(data);
  }

  async clear(): Promise<void> {
    this.raw = null;
  }

  async quarantine(): Promise<string> {
    this.raw = null;
    return "memory.quarantined";
  }
}

const noopFiles: FileTransfer = {
  async saveJson() {
    return false;
  },
  async openJson() {
    return null;
  },
};

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function chunksFrom(items: Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        yield item;
      }
    },
  };
}

describe("chatCompletionsUrl", () => {
  it("normalizes trailing slashes and appends /chat/completions once", () => {
    expect(chatCompletionsUrl("https://api.example.com/v1")).toEqual({
      ok: true,
      url: "https://api.example.com/v1/chat/completions",
    });
    expect(chatCompletionsUrl("https://api.example.com/v1///")).toEqual({
      ok: true,
      url: "https://api.example.com/v1/chat/completions",
    });
    expect(chatCompletionsUrl("https://api.example.com/v1/chat/completions")).toEqual({
      ok: true,
      url: "https://api.example.com/v1/chat/completions",
    });
    expect(chatCompletionsUrl("https://api.example.com/v1/chat/completions/")).toEqual({
      ok: true,
      url: "https://api.example.com/v1/chat/completions",
    });
    expect(chatCompletionsUrl("https://api.example.com/openai?api-version=2025-01-01")).toEqual({
      ok: true,
      url: "https://api.example.com/openai/chat/completions?api-version=2025-01-01",
    });
  });

  it("allows http only on loopback and rejects embedded credentials", () => {
    expect(chatCompletionsUrl("http://localhost:11434/v1").ok).toBe(true);
    expect(chatCompletionsUrl("http://127.0.0.1:8080/v1").ok).toBe(true);
    expect(chatCompletionsUrl("http://[::1]:8080/v1").ok).toBe(true);
    expect(chatCompletionsUrl("http://api.example.com/v1").ok).toBe(false);
    expect(chatCompletionsUrl("https://user:secret@api.example.com/v1").ok).toBe(false);
  });
});

describe("SseParser and streamChatCompletion", () => {
  it("parses fragmented SSE with split multi-byte UTF-8, split CRLF, comments, empty deltas, and [DONE]", () => {
    const parser = new SseParser();
    const full =
      ": keep-alive\r\n" +
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\r\n\r\n' +
      'data: {"choices":[{"delta":{"content":"Hoi ë — €"}}]}\r\n\r\n' +
      "data: [DONE]\r\n\r\n";
    const bytes = encode(full);
    const events: string[] = [];

    // Feed 1 byte at a time so multi-byte UTF-8 characters (ë, —, €) and \r\n are split mid-sequence
    for (let i = 0; i < bytes.length; i += 1) {
      for (const ev of parser.push(bytes.subarray(i, i + 1))) {
        events.push(ev.data);
      }
    }
    for (const ev of parser.end()) {
      events.push(ev.data);
    }

    expect(events).toEqual([
      '{"choices":[{"delta":{"role":"assistant"}}]}',
      '{"choices":[{"delta":{"content":"Hoi ë — €"}}]}',
      "[DONE]",
    ]);
  });

  it("streams assistant text incrementally while ignoring reasoning fields", async () => {
    const receivedDuringStream: string[] = [];
    const transport: HttpTransport = {
      async request(): Promise<HttpResponse> {
        const lines = [
          'data: {"choices":[{"delta":{"reasoning":"interne gedachte","reasoning_content":"geheim"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"Hallo "},"reasoning":"meer"}]}\n\n',
          'data: {"choices":[{"delta":{}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"wereld!"}}]}\n\n',
          "data: [DONE]\n\n",
        ];
        const parts: Uint8Array[] = [];
        for (const line of lines) {
          const b = encode(line);
          parts.push(b.subarray(0, 7), b.subarray(7));
        }
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: chunksFrom(parts),
        };
      },
    };

    const result = await streamChatCompletion({
      transport,
      url: "https://api.example.com/v1/chat/completions",
      model: "test-model",
      messages: [{ role: "user", content: "Hoi" }],
      onText(delta) {
        receivedDuringStream.push(delta);
      },
    });

    expect(receivedDuringStream).toEqual(["Hallo ", "wereld!"]);
    expect(result.text).toBe("Hallo wereld!");
    expect(result.text).not.toContain("interne gedachte");
    expect(result.text).not.toContain("geheim");
  });

  it("detects broken streams that close without [DONE] or finish_reason", async () => {
    const transport: HttpTransport = {
      async request(): Promise<HttpResponse> {
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: chunksFrom([encode('data: {"choices":[{"delta":{"content":"Halve zin"}}]}\n\n')]),
        };
      },
    };

    await expect(
      streamChatCompletion({
        transport,
        url: "https://api.example.com/v1/chat/completions",
        model: "test-model",
        messages: [{ role: "user", content: "Hoi" }],
      }),
    ).rejects.toMatchObject({
      kind: "stream",
    });
  });

  it("maps HTTP 401, 404, and 429 to Dutch errors and redacts secrets", async () => {
    const secret = "sk-supersecretkey1234567890abcdef";
    const makeTransport = (
      status: number,
      body: string,
      headers: Record<string, string> = {},
    ): HttpTransport => ({
      async request(): Promise<HttpResponse> {
        return { status, headers, body: chunksFrom([encode(body)]) };
      },
    });

    await expect(
      streamChatCompletion({
        transport: makeTransport(401, JSON.stringify({ error: { message: `Invalid key ${secret}` } })),
        url: "https://api.example.com/v1/chat/completions",
        model: "m",
        messages: [{ role: "user", content: "Hoi" }],
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AiError);
      const aiErr = err as AiError;
      expect(aiErr.kind).toBe("auth");
      expect(aiErr.message).not.toContain(secret);
      return true;
    });

    await expect(
      streamChatCompletion({
        transport: makeTransport(404, JSON.stringify({ error: { message: "Model not found" } })),
        url: "https://api.example.com/v1/chat/completions",
        model: "onbekend-model",
        messages: [{ role: "user", content: "Hoi" }],
      }),
    ).rejects.toMatchObject({ kind: "not-found" });

    await expect(
      streamChatCompletion({
        transport: makeTransport(429, "Too Many Requests", { "retry-after": "15" }),
        url: "https://api.example.com/v1/chat/completions",
        model: "m",
        messages: [{ role: "user", content: "Hoi" }],
      }),
    ).rejects.toSatisfy((err: unknown) => {
      const aiErr = err as AiError;
      expect(aiErr.kind).toBe("rate-limit");
      expect(aiErr.message).toContain("15 seconden");
      return true;
    });
  });
});

describe("Endpoint-bound credentials and secret exclusion", () => {
  it("binds secrets to the normalized endpoint and does not reuse them when endpoint changes", async () => {
    const secrets = new MemorySecretStore();
    await secrets.save("https://api-one.example.com/v1/chat/completions", "sk-secret-for-one-1234567890");

    expect(await secrets.has("https://api-one.example.com/v1/chat/completions")).toBe(true);
    expect(await secrets.has("https://api-two.example.com/v1/chat/completions")).toBe(false);

    const transport = new FetchTransport(secrets);
    await expect(
      transport.request({
        url: "https://api-two.example.com/v1/chat/completions",
        method: "POST",
        headers: {},
        bearerFromSecret: true,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).kind).toBe("missing-secret");
      return true;
    });
  });

  it("excludes secrets and settings dumps from serialized AppData, context prompts, and redacted logs", () => {
    const data = createDefaultData(false);
    data.settings.ai.baseUrl = "https://api.example.com/v1";
    data.settings.ai.model = "gpt-test";
    data.profile.name = "Sanne";
    data.profile.studyContext = "Psychologie";
    data.ownTasks.push({
      id: "t1",
      title: "Hoofdstuk 3 samenvatten",
      notes: "Statistiek",
      dueAt: "2026-10-20",
      estimateMinutes: 60,
      priority: "middel",
      done: false,
      createdAt: "2026-10-14T09:00:00.000Z",
    });
    const convId = addUserMessage(data, null, "Hoe plan ik mijn week?");

    const serialized = serializeAppData(data);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("Bearer");

    const messages = buildChatMessages(data, convId, new Date("2026-10-14T12:00:00.000Z"));
    const promptDump = JSON.stringify(messages);
    expect(promptDump).toContain("Sanne");
    expect(promptDump).toContain("Hoofdstuk 3 samenvatten");
    expect(promptDump).toContain("Europe/Amsterdam");
    expect(promptDump).toContain("Canvas is nog niet aangesloten");
    expect(promptDump).not.toContain("https://api.example.com");

    expect(redactSecrets("Authorization: Bearer sk-1234567890abcdefghijklmnop")).not.toContain(
      "sk-1234567890abcdefghijklmnop",
    );
  });

  it("marks interrupted streaming replies as failed when loading stored data", () => {
    const raw = createDefaultData(false);
    const convId = addUserMessage(raw, null, "Hallo");
    raw.conversations.find((c) => c.id === convId)!.messages.push({
      id: "m-stream",
      role: "assistant",
      content: "Deels ontvangen...",
      createdAt: "2026-10-14T10:00:00.000Z",
      status: "streaming",
    });

    const result = validateAppData(JSON.parse(serializeAppData(raw)), false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const msg = result.data.conversations[0].messages[1];
    expect(msg.status).toBe("failed");
    expect(msg.content).toBe("Deels ontvangen...");
    expect(msg.error).toContain("Onderbroken");
  });
});

describe("ChatRunner streaming, stop, retry, and conversation isolation", () => {
  async function createSetup(transport: HttpTransport, hasSecret = true) {
    const store = new InMemoryDataStore();
    const secrets: SecretStore = {
      persistence: "session",
      async has() {
        return hasSecret;
      },
      async save() {},
      async remove() {},
    };
    const platform: Platform = {
      id: "web",
      dataStore: store,
      files: noopFiles,
      secrets,
      http: transport,
      mcp: {
        async discover() {
          throw new Error("not used in ai test");
        },
        async callTool() {
          throw new Error("not used in ai test");
        },
        async disconnect() {},
      },
      capabilities: { builtInMcp: false },
    };
    const controller = new DataController(platform);
    await controller.load();
    controller.update((d) => {
      d.settings.ai.baseUrl = "https://api.example.com/v1";
      d.settings.ai.model = "test-model";
    });
    // Use 0ms update interval so streaming flushes immediately in tests
    const runner = new ChatRunner(platform, controller, () => new Date("2026-10-14T12:00:00.000Z"), 0);
    return { controller, runner, store };
  }

  it("streams chunks incrementally, supports stopping mid-stream, and retries without duplicating the user message", async () => {
    let callCount = 0;

    const transport: HttpTransport = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        callCount += 1;
        if (callCount === 1) {
          return {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: {
              async *[Symbol.asyncIterator]() {
                yield encode('data: {"choices":[{"delta":{"content":"Eerste deel..."}}]}\n\n');
                await new Promise<void>((_, reject) => {
                  req.signal?.addEventListener("abort", () => {
                    reject(new TransportError("aborted", "Geannuleerd"));
                  });
                });
              },
            },
          };
        }
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: chunksFrom([
            encode('data: {"choices":[{"delta":{"content":"Volledig nieuw antwoord."}}]}\n\n'),
            encode("data: [DONE]\n\n"),
          ]),
        };
      },
    };

    const { controller, runner } = await createSetup(transport);
    const convId = runner.send(null, "Kun je helpen plannen?")!;
    expect(convId).toBeTruthy();

    // Wait briefly so the first chunk is flushed while the stream is still open
    await new Promise((r) => setTimeout(r, 25));
    const midStreamConv = controller.getSnapshot().data!.conversations.find((c) => c.id === convId)!;
    expect(midStreamConv.messages).toHaveLength(2);
    expect(midStreamConv.messages[1].content).toBe("Eerste deel...");
    expect(midStreamConv.messages[1].status).toBe("streaming");

    // Stop the active stream
    runner.stop(convId);
    await new Promise((r) => setTimeout(r, 25));

    const stoppedConv = controller.getSnapshot().data!.conversations.find((c) => c.id === convId)!;
    expect(stoppedConv.messages).toHaveLength(2);
    expect(stoppedConv.messages[0].role).toBe("user");
    expect(stoppedConv.messages[1].status).toBe("stopped");
    expect(stoppedConv.messages[1].content).toBe("Eerste deel...");

    // Retry should replace the stopped assistant reply without duplicating the user message
    runner.retry(convId);
    await new Promise((r) => setTimeout(r, 25));

    const retriedConv = controller.getSnapshot().data!.conversations.find((c) => c.id === convId)!;
    expect(retriedConv.messages).toHaveLength(2);
    expect(retriedConv.messages[0].role).toBe("user");
    expect(retriedConv.messages[0].content).toBe("Kun je helpen plannen?");
    expect(retriedConv.messages[1].role).toBe("assistant");
    expect(retriedConv.messages[1].status).toBe("completed");
    expect(retriedConv.messages[1].content).toBe("Volledig nieuw antwoord.");
  });

  it("keeps streaming updates attached to the originating conversation and cancels on deletion", async () => {
    let abortCount = 0;
    const transport: HttpTransport = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: {
            async *[Symbol.asyncIterator]() {
              yield encode('data: {"choices":[{"delta":{"content":"Bezig..."}}]}\n\n');
              await new Promise<void>((_, reject) => {
                req.signal?.addEventListener("abort", () => {
                  abortCount += 1;
                  reject(new TransportError("aborted", "Geannuleerd"));
                });
              });
            },
          },
        };
      },
    };

    const { controller, runner } = await createSetup(transport);
    let secondId = "";
    controller.update((d) => {
      secondId = addUserMessage(d, null, "Eerdere vraag");
    });

    const firstId = runner.send(null, "Vraag in eerste gesprek")!;
    await new Promise((r) => setTimeout(r, 25));

    // Second conversation must remain untouched (only its 1 user message)
    const currentSecond = controller.getSnapshot().data!.conversations.find((c) => c.id === secondId)!;
    expect(currentSecond.messages).toHaveLength(1);

    // Deleting the first conversation cancels its in-flight stream
    runner.cancel(firstId);
    controller.update((d) => {
      deleteConversation(d, firstId);
    });
    await new Promise((r) => setTimeout(r, 25));

    expect(abortCount).toBe(1);
    expect(controller.getSnapshot().data!.conversations.some((c) => c.id === firstId)).toBe(false);
  });

  it("verifies connection with testConnection only when valid completion arrives", async () => {
    const okTransport: HttpTransport = {
      async request(): Promise<HttpResponse> {
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: chunksFrom([
            encode('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'),
            encode("data: [DONE]\n\n"),
          ]),
        };
      },
    };
    const reply = await testConnection(okTransport, "https://api.example.com/v1/chat/completions", "m-1");
    expect(reply).toBe("OK");
  });
});

function createReviewedMcpDiscovery(): McpDiscoveryResult {
  return {
    serverName: "plums-canvas-test",
    serverVersion: "0.1.0",
    protocolVersion: "2025-03-26",
    tools: [
      {
        name: CANONICAL_TOOLS.courses,
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
      {
        name: CANONICAL_TOOLS.assignments,
        inputSchema: {
          type: "object",
          properties: {
            course_id: { type: "string" },
            bucket: { type: "string" },
            search_term: { type: "string" },
          },
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: CANONICAL_TOOLS.submissions,
        inputSchema: {
          type: "object",
          properties: {
            course_id: { type: "string" },
            assignment_ids: { type: "array" },
          },
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: CANONICAL_TOOLS.announcements,
        inputSchema: {
          type: "object",
          properties: {
            course_ids: { type: "array" },
            start_date: { type: "string" },
            end_date: { type: "string" },
          },
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: CANONICAL_TOOLS.calendar,
        inputSchema: {
          type: "object",
          properties: {
            course_ids: { type: "array" },
            start_date: { type: "string" },
            end_date: { type: "string" },
          },
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: CANONICAL_TOOLS.modules,
        inputSchema: {
          type: "object",
          properties: {
            course_id: { type: "string" },
            search_term: { type: "string" },
          },
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: CANONICAL_TOOLS.page,
        inputSchema: {
          type: "object",
          properties: {
            course_id: { type: "string" },
            page_url_or_id: { type: "string" },
          },
        },
        annotations: { readOnlyHint: true },
      },
    ],
  };
}

describe("Step 5B — AI tool loop, Canvas MCP integration, and provenance enforcement", () => {
  async function createCanvasAiSetup(options: {
    httpHandler: (req: HttpRequest, roundIndex: number) => Promise<HttpResponse>;
    mcpCallHandler?: (
      target: McpTargetConfig,
      toolName: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<McpToolCallResult>;
  }) {
    const store = new InMemoryDataStore();
    const secrets = new MemorySecretStore();
    await secrets.save("https://api.example.com/v1/chat/completions", "sk-ai-secret-123456");
    await secrets.save("canvas:https://canvas.example.edu", "canvas-token-123456");

    let roundIndex = 0;
    const http: HttpTransport = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        const idx = roundIndex++;
        return options.httpHandler(req, idx);
      },
    };

    const mcp: McpClient = {
      async discover() {
        return createReviewedMcpDiscovery();
      },
      async callTool(target, toolName, args, signal) {
        if (options.mcpCallHandler) {
          return options.mcpCallHandler(target, toolName, args, signal);
        }
        return { isError: false, textContent: "[]" };
      },
      async disconnect() {},
    };

    const platform: Platform = {
      id: "desktop",
      dataStore: store,
      files: noopFiles,
      secrets,
      http,
      mcp,
      capabilities: { builtInMcp: true },
    };

    const controller = new DataController(platform);
    await controller.load();
    controller.update((d) => {
      d.settings.ai.baseUrl = "https://api.example.com/v1";
      d.settings.ai.model = "gpt-test";
      d.settings.mcp.mode = "builtin";
      d.settings.canvas.baseUrl = "https://canvas.example.edu";
      d.settings.canvas.selectedCourseIds = ["101", "202"];
      d.settings.canvas.categories = {
        assignments: true,
        submissions: true,
        announcements: true,
        calendar: true,
        modules: true,
      };
    });

    const canvas = new CanvasService(controller, mcp, secrets, true);
    const runner = new ChatRunner(
      platform,
      controller,
      () => new Date("2026-10-14T12:00:00.000Z"),
      0,
      canvas,
    );

    return { controller, canvas, runner, secrets };
  }

  it("accumulates fragmented streamed tool_calls by index/ID and pairs tool results back to the model", async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    const mcpCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];

    const { controller, runner } = await createCanvasAiSetup({
      async httpHandler(req, roundIndex) {
        const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
        capturedBodies.push(body);

        if (roundIndex === 0) {
          // Stream two tool calls with fragmented function names and fragmented JSON arguments across deltas
          const events = [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a1","type":"function","function":{"name":"canvas_list_","arguments":"{\\"cour"}}]}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"assignments","arguments":"se_id\\":\\"101\\",\\"buck"}}]}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b2","type":"function","function":{"name":"canvas_list_own_","arguments":"{\\"course_"}}]}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"et\\":\\"upcoming\\"}"}},{"index":1,"function":{"name":"submissions","arguments":"id\\":\\"101\\"}"}}]}}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
            "data: [DONE]\n\n",
          ];
          return {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: chunksFrom(events.map(encode)),
          };
        }

        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: chunksFrom([
            encode(
              'data: {"choices":[{"delta":{"content":"Je hebt **Opdracht 1** (deadline 2026-10-20) voor [Opdracht 1](https://canvas.example.edu/courses/101/assignments/555)."}}]}\n\n',
            ),
            encode("data: [DONE]\n\n"),
          ]),
        };
      },
      async mcpCallHandler(_target, toolName, args) {
        mcpCalls.push({ toolName, args });
        if (toolName === CANONICAL_TOOLS.assignments) {
          return {
            isError: false,
            textContent: JSON.stringify([
              {
                id: 555,
                course_id: 101,
                name: "Opdracht 1",
                description: "<p>Implementeer de parser</p>",
                due_at: "2026-10-20T21:59:00Z",
                html_url: "https://canvas.example.edu/courses/101/assignments/555",
              },
            ]),
          };
        }
        return {
          isError: false,
          textContent: JSON.stringify([
            {
              id: 901,
              assignment_id: 555,
              workflow_state: "unsubmitted",
              submitted_at: null,
              missing: false,
              late: false,
            },
          ]),
        };
      },
    });

    // Disable announcements in settings to verify only enabled tools are advertised
    controller.update((d) => {
      d.settings.canvas.categories.announcements = false;
    });

    const convId = runner.send(null, "Welke deadlines en inleverstatus heb ik voor vak 101?")!;
    await new Promise((r) => setTimeout(r, 40));

    // Legacy `bucket` in the streamed args must be stripped — never forwarded to Canvas.
    expect(mcpCalls).toEqual([
      { toolName: "canvas_list_assignments", args: { course_id: "101" } },
      { toolName: "canvas_get_own_submissions", args: { course_id: "101" } },
    ]);
    const assignTool = (capturedBodies[0].tools as Array<{ function: { name: string; parameters: { properties: Record<string, unknown> } } }>).find(
      (t) => t.function.name === "canvas_list_assignments",
    );
    expect(assignTool?.function.parameters.properties).not.toHaveProperty("bucket");

    // Check advertised tools in round 0: announcements must be excluded because its category is disabled
    const round0Tools = (capturedBodies[0].tools as Array<{ function: { name: string } }>).map(
      (t) => t.function.name,
    );
    expect(round0Tools).toContain("canvas_list_assignments");
    expect(round0Tools).toContain("canvas_list_own_submissions");
    expect(round0Tools).not.toContain("canvas_list_announcements");

    // Check round 1 messages: must contain the assistant tool_calls and two paired role:"tool" messages
    const round1Messages = capturedBodies[1].messages as Array<Record<string, unknown>>;
    const toolMsgs = round1Messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[0].tool_call_id).toBe("call_a1");
    expect(String(toolMsgs[0].content)).toContain("<canvas_gegevens>");
    expect(String(toolMsgs[0].content)).toContain("Opdracht 1");
    expect(toolMsgs[1].tool_call_id).toBe("call_b2");
    expect(String(toolMsgs[1].content)).toContain("unsubmitted");

    // Final message persisted with provenance, sources, and toolSteps
    const conv = controller.getSnapshot().data!.conversations.find((c) => c.id === convId)!;
    const reply = conv.messages[1];
    expect(reply.status).toBe("completed");
    expect(reply.content).toContain("Opdracht 1");
    expect(reply.toolSteps).toHaveLength(2);
    expect(reply.toolSteps?.[0].status).toBe("success");
    expect(reply.sources).toHaveLength(2);
    expect(reply.sources?.[0].url).toBe("https://canvas.example.edu/courses/101/assignments/555");
    expect(reply.canvasProvenance).toEqual({
      scopeId: "builtin:https://canvas.example.edu:v0",
      categories: ["assignments", "submissions"],
      courseIds: ["101"],
      sourceIds: ["canvas:assignment:101:555", "canvas:submission:101:555"],
    });
  });

  it("rejects unknown tools, unselected courses, disabled categories, and forbidden user_id/endpoint parameters", async () => {
    let mcpExecuted = false;
    const capturedBodies: Array<Record<string, unknown>> = [];

    const { controller, runner } = await createCanvasAiSetup({
      async httpHandler(req, roundIndex) {
        capturedBodies.push(JSON.parse(req.body ?? "{}") as Record<string, unknown>);
        if (roundIndex === 0) {
          const toolCalls = [
            {
              index: 0,
              id: "call_unknown",
              type: "function",
              function: { name: "canvas_delete_course", arguments: '{"course_id":"101"}' },
            },
            {
              index: 1,
              id: "call_unselected",
              type: "function",
              function: { name: "canvas_list_assignments", arguments: '{"course_id":"999"}' },
            },
            {
              index: 2,
              id: "call_forbidden_param",
              type: "function",
              function: {
                name: "canvas_list_own_submissions",
                arguments: '{"course_id":"101","user_id":"42"}',
              },
            },
          ];
          return {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: chunksFrom([
              encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls }, finish_reason: "tool_calls" }] })}\n\n`),
              encode("data: [DONE]\n\n"),
            ]),
          };
        }
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: chunksFrom([
            encode('data: {"choices":[{"delta":{"content":"Sommige acties zijn geweigerd."}}]}\n\n'),
            encode("data: [DONE]\n\n"),
          ]),
        };
      },
      async mcpCallHandler() {
        mcpExecuted = true;
        return { isError: false, textContent: "[]" };
      },
    });

    const convId = runner.send(null, "Test beveiliging")!;
    await new Promise((r) => setTimeout(r, 40));

    expect(mcpExecuted).toBe(false);
    const round1Messages = capturedBodies[1].messages as Array<Record<string, unknown>>;
    const toolMsgs = round1Messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(3);
    expect(String(toolMsgs[0].content)).toContain('"status": "denied"');
    expect(String(toolMsgs[1].content)).toContain('"status": "denied"');
    expect(String(toolMsgs[1].content)).toContain("niet geselecteerd");
    expect(String(toolMsgs[2].content)).toContain('"status": "denied"');
    expect(String(toolMsgs[2].content)).toContain("user_id");

    const conv = controller.getSnapshot().data!.conversations.find((c) => c.id === convId)!;
    expect(conv.messages[1].toolSteps?.every((s) => s.status === "denied")).toBe(true);
  });

  it("keeps executing Canvas tools across many rounds until the model stops requesting them", async () => {
    let httpRounds = 0;
    let mcpCalls = 0;

    const { controller, runner } = await createCanvasAiSetup({
      async httpHandler(_req, roundIndex) {
        httpRounds += 1;
        // Six tool rounds (beyond the old cap of 4), then a final text answer.
        if (roundIndex < 6) {
          return {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: chunksFrom([
              encode(
                `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_r${roundIndex}","type":"function","function":{"name":"canvas_list_courses","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n`,
              ),
              encode("data: [DONE]\n\n"),
            ]),
          };
        }
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: chunksFrom([
            encode(
              'data: {"choices":[{"delta":{"content":"Klaar na alle Canvas-zoekrondes."}}]}\n\n',
            ),
            encode("data: [DONE]\n\n"),
          ]),
        };
      },
      async mcpCallHandler() {
        mcpCalls += 1;
        return {
          isError: false,
          textContent: JSON.stringify([{ id: 101, name: "Software Engineering" }]),
        };
      },
    });

    const convId = runner.send(null, "Blijf zoeken")!;
    await new Promise((r) => setTimeout(r, 80));

    expect(httpRounds).toBe(7);
    expect(mcpCalls).toBe(6);
    const conv = controller.getSnapshot().data!.conversations.find((c) => c.id === convId)!;
    expect(conv.messages[1].status).toBe("completed");
    expect(conv.messages[1].toolSteps).toHaveLength(6);
    expect(conv.messages[1].content).toContain("Klaar na alle Canvas-zoekrondes");
    expect(conv.messages[1].content).not.toContain("Limiet bereikt");
    expect(conv.messages[1].content).not.toContain("maximale aantal");
  });

  it("explains missing tool-calling capability in Dutch without claiming Canvas was consulted", async () => {
    const { controller, runner } = await createCanvasAiSetup({
      async httpHandler() {
        return {
          status: 400,
          headers: { "content-type": "application/json" },
          body: chunksFrom([
            encode(
              JSON.stringify({
                error: { message: "This model does not support tools or function calling." },
              }),
            ),
          ]),
        };
      },
    });

    const convId = runner.send(null, "Wat zijn mijn opdrachten?")!;
    await new Promise((r) => setTimeout(r, 30));

    const conv = controller.getSnapshot().data!.conversations.find((c) => c.id === convId)!;
    expect(conv.messages[1].status).toBe("failed");
    expect(conv.messages[1].error).toContain("ondersteunt geen tool-calling");
    expect(conv.messages[1].error).toContain("Canvas is daarom niet geraadpleegd");
  });

  it("excludes assistant messages from subsequent AI requests and history search after disabling their category, course, or changing connection/account", async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];

    const { controller, canvas, runner } = await createCanvasAiSetup({
      async httpHandler(req, roundIndex) {
        capturedBodies.push(JSON.parse(req.body ?? "{}") as Record<string, unknown>);
        if (roundIndex === 0) {
          return {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: chunksFrom([
              encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"canvas_list_assignments","arguments":"{\\"course_id\\":\\"101\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
              ),
              encode("data: [DONE]\n\n"),
            ]),
          };
        }
        const replyText =
          roundIndex <= 2
            ? `Antwoord ronde ${roundIndex}: GEHEIME_OPDRACHT_X99`
            : "Antwoord ronde 3: Geen opdrachten toegankelijk.";
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: chunksFrom([
            encode(`data: {"choices":[{"delta":{"content":"${replyText}"}}]}\n\n`),
            encode("data: [DONE]\n\n"),
          ]),
        };
      },
      async mcpCallHandler() {
        return {
          isError: false,
          textContent: JSON.stringify([
            { id: 77, course_id: 101, name: "GEHEIME_OPDRACHT_X99", due_at: "2026-11-01T12:00:00Z" },
          ]),
        };
      },
    });

    // Turn 1: fetches assignments for course 101
    const convId = runner.send(null, "Welke opdrachten heeft vak 101?")!;
    await new Promise((r) => setTimeout(r, 40));

    const convAfterTurn1 = controller.getSnapshot().data!.conversations.find((c) => c.id === convId)!;
    expect(convAfterTurn1.messages[1].content).toContain("GEHEIME_OPDRACHT_X99");
    expect(convAfterTurn1.messages[1].canvasProvenance?.categories).toContain("assignments");

    // Turn 2 (while assignments & course 101 are still enabled): the assistant message IS included in context
    runner.send(convId, "Kun je dat samenvatten?");
    await new Promise((r) => setTimeout(r, 40));
    const turn2Prompt = JSON.stringify(capturedBodies[2].messages);
    expect(turn2Prompt).toContain("GEHEIME_OPDRACHT_X99");

    // Now disable the `assignments` category!
    controller.update((d) => {
      d.settings.canvas.categories.assignments = false;
    });

    // Historical message remains visible in the stored conversation for the UI:
    const visibleConv = controller.getSnapshot().data!.conversations.find((c) => c.id === convId)!;
    expect(visibleConv.messages[1].content).toContain("GEHEIME_OPDRACHT_X99");

    // Turn 3 in the same conversation: the derived assistant message MUST be excluded from new AI context!
    runner.send(convId, "En hoe zit het nu?");
    await new Promise((r) => setTimeout(r, 40));
    const turn3Prompt = JSON.stringify(capturedBodies[3].messages);
    expect(turn3Prompt).not.toContain("GEHEIME_OPDRACHT_X99");

    // Also verify older-history search (`selectRelevantHistory`) across conversations:
    // Re-enable assignments, verify it's found in history search, then deselect course 101 or bump credential epoch
    controller.update((d) => {
      d.settings.canvas.categories.assignments = true;
    });
    const dataSnapshot1 = controller.getSnapshot().data!;
    expect(
      selectRelevantHistory(
        dataSnapshot1.conversations,
        "other-conv-id",
        "GEHEIME_OPDRACHT_X99",
        canvas.getActiveScope()!,
      ),
    ).toContain("GEHEIME_OPDRACHT_X99");

    // Deselect course 101 -> excluded from history search
    controller.update((d) => {
      d.settings.canvas.selectedCourseIds = ["202"];
    });
    expect(
      selectRelevantHistory(
        controller.getSnapshot().data!.conversations,
        "other-conv-id",
        "GEHEIME_OPDRACHT_X99",
        canvas.getActiveScope()!,
      ),
    ).not.toContain("GEHEIME_OPDRACHT_X99");

    // Re-select course 101, but change account/credential -> excluded from history search
    controller.update((d) => {
      d.settings.canvas.selectedCourseIds = ["101", "202"];
    });
    await canvas.notifyCredentialChanged();
    expect(
      selectRelevantHistory(
        controller.getSnapshot().data!.conversations,
        "other-conv-id",
        "GEHEIME_OPDRACHT_X99",
        canvas.getActiveScope()!,
      ),
    ).not.toContain("GEHEIME_OPDRACHT_X99");
  });

  it("cancels an active AI + MCP run immediately when a used category is disabled mid-run", async () => {
    let mcpSignalAborted = false;

    const { controller, runner } = await createCanvasAiSetup({
      async httpHandler(_req, roundIndex) {
        if (roundIndex === 0) {
          return {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: chunksFrom([
              encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_slow","type":"function","function":{"name":"canvas_list_assignments","arguments":"{\\"course_id\\":\\"101\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
              ),
              encode("data: [DONE]\n\n"),
            ]),
          };
        }
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: chunksFrom([encode("data: [DONE]\n\n")]),
        };
      },
      async mcpCallHandler(_target, _toolName, _args, signal) {
        await new Promise<void>((_, reject) => {
          signal?.addEventListener("abort", () => {
            mcpSignalAborted = true;
            reject(new Error("aborted"));
          });
        });
        return { isError: false, textContent: "[]" };
      },
    });

    const convId = runner.send(null, "Haal opdrachten op")!;
    await new Promise((r) => setTimeout(r, 25));

    // Disable `assignments` while the MCP tool call is in flight
    controller.update((d) => {
      d.settings.canvas.categories.assignments = false;
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(mcpSignalAborted).toBe(true);
    const conv = controller.getSnapshot().data!.conversations.find((c) => c.id === convId)!;
    expect(conv.messages[1].status).toBe("stopped");
    expect(conv.messages[1].error).toContain("gewijzigd");
  });

  it("distinguishes empty results, partial/truncated results, and failed reads so failed reads never look like 'no deadlines'", async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];

    const { controller, runner } = await createCanvasAiSetup({
      async httpHandler(req, roundIndex) {
        capturedBodies.push(JSON.parse(req.body ?? "{}") as Record<string, unknown>);
        if (roundIndex === 0) {
          const toolCalls = [
            {
              index: 0,
              id: "call_empty",
              type: "function",
              function: { name: "canvas_list_announcements", arguments: '{"course_ids":["101"]}' },
            },
            {
              index: 1,
              id: "call_partial",
              type: "function",
              function: { name: "canvas_list_calendar_events", arguments: '{"course_ids":["101"]}' },
            },
            {
              index: 2,
              id: "call_failed",
              type: "function",
              function: { name: "canvas_list_assignments", arguments: '{"course_id":"101"}' },
            },
          ];
          return {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: chunksFrom([
              encode(
                `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls }, finish_reason: "tool_calls" }] })}\n\n`,
              ),
              encode("data: [DONE]\n\n"),
            ]),
          };
        }
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: chunksFrom([
            encode(
              'data: {"choices":[{"delta":{"content":"Announcements zijn leeg, agenda is gedeeltelijk geladen, en opdrachten ophalen is mislukt (dus ik kan niet zeggen of je deadlines hebt)."}}]}\n\n',
            ),
            encode("data: [DONE]\n\n"),
          ]),
        };
      },
      async mcpCallHandler(_target, toolName) {
        if (toolName === CANONICAL_TOOLS.announcements) {
          return { isError: false, textContent: "[]" };
        }
        if (toolName === CANONICAL_TOOLS.calendar) {
          // Return 30 items (> MAX_ITEMS_PER_TOOL_RESULT = 25) to trigger partial/truncated status
          const many = Array.from({ length: 30 }, (_, idx) => ({
            id: idx + 1,
            context_code: "course_101",
            title: `College ${idx + 1}`,
            start_at: "2026-10-21T09:00:00Z",
          }));
          return { isError: false, textContent: JSON.stringify(many) };
        }
        return { isError: true, textContent: "Canvas API HTTP 503 Service Unavailable" };
      },
    });

    const convId = runner.send(null, "Check mijn vak 101")!;
    await new Promise((r) => setTimeout(r, 40));

    const round1Messages = capturedBodies[1].messages as Array<Record<string, unknown>>;
    const toolMsgs = round1Messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(3);
    expect(String(toolMsgs[0].content)).toContain('"status": "empty"');
    expect(String(toolMsgs[1].content)).toContain('"status": "partial"');
    expect(String(toolMsgs[1].content)).toContain('"partial_or_truncated": true');
    expect(String(toolMsgs[2].content)).toContain('"status": "failed"');
    expect(String(toolMsgs[2].content)).toContain(
      "Concludeer hieruit NOOIT dat er geen deadlines, opdrachten of berichten zijn!",
    );

    const conv = controller.getSnapshot().data!.conversations.find((c) => c.id === convId)!;
    expect(conv.messages[1].toolSteps?.map((s) => s.status)).toEqual(["empty", "partial", "failed"]);
  });

  it("handles 403 submission failures as unknown (never unsubmitted), teacher enrollments as not_applicable, recurring past dates accurately, and never fetches disabled submissions via includes/fallback", async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    const mcpCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];

    const { controller, runner } = await createCanvasAiSetup({
      async httpHandler(req, roundIndex) {
        const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
        capturedBodies.push(body);
        const msgs = (body.messages as Array<Record<string, unknown>>) ?? [];
        const hasToolMsgInTurn = msgs.some((m) => m.role === "tool");
        if (!hasToolMsgInTurn || roundIndex === 0) {
          const toolCalls = [
            {
              index: 0,
              id: "call_assign",
              type: "function",
              function: { name: "canvas_list_assignments", arguments: '{"course_id":"101"}' },
            },
            {
              index: 1,
              id: "call_sub_403",
              type: "function",
              function: { name: "canvas_list_own_submissions", arguments: '{"course_id":"101"}' },
            },
            {
              index: 2,
              id: "call_sub_teacher",
              type: "function",
              function: { name: "canvas_list_own_submissions", arguments: '{"course_id":"202"}' },
            },
          ];
          return {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: chunksFrom([
              encode(
                `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls }, finish_reason: "tool_calls" }] })}\n\n`,
              ),
              encode("data: [DONE]\n\n"),
            ]),
          };
        }
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: chunksFrom([
            encode(
              'data: {"choices":[{"delta":{"content":"De deadline van Peilmoment [recurring] is 9 oktober 2026 en de inleverstatus is Onbekend / Niet van toepassing."}}]}\n\n',
            ),
            encode("data: [DONE]\n\n"),
          ]),
        };
      },
      async mcpCallHandler(_target, toolName, args) {
        mcpCalls.push({ toolName, args });
        if (toolName === CANONICAL_TOOLS.assignments) {
          return {
            isError: false,
            structuredContent: {
              items: [
                {
                  id: "9001",
                  course_id: "101",
                  name: "Peilmoment [recurring]",
                  due_at: "2026-10-09T14:00:00Z",
                  has_submitted_submissions: true,
                  html_url: "https://fhict.instructure.com/courses/101/assignments/9001",
                },
              ],
            },
            textContent: "[]",
          };
        }
        if (toolName === CANONICAL_TOOLS.submissions && args.course_id === "101") {
          return {
            isError: true,
            textContent:
              "Geen toegang tot dit Canvas-onderdeel op GET /api/v1/courses/101/students/submissions (HTTP 403).",
          };
        }
        if (toolName === CANONICAL_TOOLS.submissions && args.course_id === "202") {
          return {
            isError: false,
            structuredContent: {
              items: [],
              enrollmentStatus: "not_applicable_non_student",
              enrollmentRoles: ["TeacherEnrollment"],
              warnings: [
                "Het gekoppelde Canvas-account is in cursus 202 ingeschreven als 'TeacherEnrollment' (geen StudentEnrollment). Eigen inleverstatus is daarom niet van toepassing.",
              ],
            },
            textContent: "[]",
          };
        }
        return { isError: false, textContent: "[]" };
      },
    });

    const convId = runner.send(null, "Wat zijn mijn opdrachten en inleverstatus?")!;
    await new Promise((r) => setTimeout(r, 40));

    const round1Messages = capturedBodies[1].messages as Array<Record<string, unknown>>;
    const toolMsgs = round1Messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(3);

    // 1. Assignment tool output preserves exact Oct 9 date and explicitly warns not to assume "Niet ingeleverd"
    const assignContent = String(toolMsgs[0].content);
    expect(assignContent).toContain('"due_at": "2026-10-09T14:00:00Z"');
    expect(assignContent).toContain("9 oktober 2026");
    expect(assignContent).not.toContain("16 oktober");
    expect(assignContent).toContain("NOOIT 'Niet ingeleverd'");

    // 2. 403 on submissions -> status "failed" with explicit instruction that status is ONBEKEND (never "Niet ingeleverd")
    const sub403Content = String(toolMsgs[1].content);
    expect(sub403Content).toContain('"status": "failed"');
    expect(sub403Content).toContain("HTTP 403");
    expect(sub403Content).toContain("ONBEKEND");
    expect(sub403Content).toContain("NOOIT als 'Niet ingeleverd'");

    // 3. Teacher enrollment on course 202 -> status "not_applicable"
    const subTeacherContent = String(toolMsgs[2].content);
    expect(subTeacherContent).toContain('"status": "not_applicable"');
    expect(subTeacherContent).toContain('"enrollment_status": "not_applicable_non_student"');
    expect(subTeacherContent).toContain("TeacherEnrollment");

    const conv = controller.getSnapshot().data!.conversations.find((c) => c.id === convId)!;
    expect(conv.messages[1].toolSteps?.map((s) => s.status)).toEqual([
      "success",
      "failed",
      "not_applicable",
    ]);

    // 4. Now disable `submissions` category and verify `submissions` is neither advertised nor fetched via includes/fallback
    mcpCalls.length = 0;
    controller.update((d) => {
      d.settings.canvas.categories.submissions = false;
    });

    // Edit the latest user message to trigger a clean regeneration under the updated permissions
    const latestUserId = conv.messages[0].id;
    const edited = runner.editLatestUserMessage(
      convId,
      latestUserId,
      "Welke opdrachten heb ik na het uitschakelen van inleverstatus?",
    );
    expect(edited).toBe(true);
    await new Promise((r) => setTimeout(r, 40));

    const afterEditConv = controller.getSnapshot().data!.conversations.find((c) => c.id === convId)!;
    // No duplicate user turn was created; the user message was updated in place
    expect(afterEditConv.messages).toHaveLength(2);
    expect(afterEditConv.messages[0].content).toBe(
      "Welke opdrachten heb ik na het uitschakelen van inleverstatus?",
    );
    // Only `canvas_list_assignments` was executed on MCP; `canvas_get_own_submissions` was blocked by policy before MCP
    expect(mcpCalls.map((c) => c.toolName)).toEqual([CANONICAL_TOOLS.assignments]);
    expect(afterEditConv.messages[1].toolSteps?.map((s) => s.status)).toEqual([
      "success",
      "denied",
      "denied",
    ]);
  });

  it("recovers once from an empty end_turn after tool results with a separate continuation message", async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    const { controller, runner } = await createCanvasAiSetup({
      async httpHandler(req, roundIndex) {
        capturedBodies.push(JSON.parse(req.body ?? "{}") as Record<string, unknown>);
        if (roundIndex === 0) {
          return {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: chunksFrom([
              encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"canvas_list_assignments","arguments":"{\\"course_id\\":\\"101\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
              ),
              encode("data: [DONE]\n\n"),
            ]),
          };
        }
        if (roundIndex === 1) {
          return {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: chunksFrom([
              encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'),
              encode("data: [DONE]\n\n"),
            ]),
          };
        }
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: chunksFrom([
            encode('data: {"choices":[{"delta":{"content":"Je hebt één opdracht zonder deadline."}}]}\n\n'),
            encode("data: [DONE]\n\n"),
          ]),
        };
      },
      async mcpCallHandler() {
        return {
          isError: false,
          structuredContent: { items: [{ id: "50", course_id: "101", name: "Huiswerk", due_at: null }] },
          textContent: "[]",
        };
      },
    });

    const convId = runner.send(null, "Welke opdrachten heb ik?")!;
    await new Promise((r) => setTimeout(r, 40));

    expect(capturedBodies).toHaveLength(3);
    const contBody = capturedBodies[2];
    expect(contBody.tools).toBeUndefined();
    const contMsgs = contBody.messages as Array<Record<string, unknown>>;
    const lastMsg = contMsgs[contMsgs.length - 1];
    expect(lastMsg.role).toBe("user");
    expect(String(lastMsg.content)).toContain("eindantwoord");
    // The empty assistant turn is not echoed back
    expect(contMsgs[contMsgs.length - 2].role).toBe("tool");

    const conv = controller.getSnapshot().data!.conversations.find((c) => c.id === convId)!;
    // The continuation prompt is never stored as a user turn
    expect(conv.messages).toHaveLength(2);
    expect(conv.messages[1].status).toBe("completed");
    expect(conv.messages[1].content).toBe("Je hebt één opdracht zonder deadline.");
  });

  it("reports an informative error when the reply stays empty after the single continuation", async () => {
    let calls = 0;
    const { controller, runner } = await createCanvasAiSetup({
      async httpHandler(_req, roundIndex) {
        calls += 1;
        if (roundIndex === 0) {
          return {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: chunksFrom([
              encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"canvas_list_assignments","arguments":"{\\"course_id\\":\\"101\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
              ),
              encode("data: [DONE]\n\n"),
            ]),
          };
        }
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: chunksFrom([
            encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'),
            encode("data: [DONE]\n\n"),
          ]),
        };
      },
      async mcpCallHandler() {
        return { isError: false, structuredContent: { items: [] }, textContent: "[]" };
      },
    });

    const convId = runner.send(null, "Welke opdrachten heb ik?")!;
    await new Promise((r) => setTimeout(r, 40));

    expect(calls).toBe(3);
    const msg = controller.getSnapshot().data!.conversations.find((c) => c.id === convId)!.messages[1];
    expect(msg.status).toBe("failed");
    expect(msg.error).toContain("na 1 Canvas-aanroep(en), ook na een vervolgverzoek");
    expect(msg.error).toContain("finish_reason: stop");
  });

  it("summarizes running, completed, partial, not_applicable, and failed steps for collapsed headers", async () => {
    const { summarizeToolActivity } = await import("../../ui/ChatView");

    // While running: shows "Canvas bekijken..." and preserves any failure badge
    const whileRunning = summarizeToolActivity(
      [
        {
          id: "1",
          operation: "assignments",
          label: "Opdrachten en deadlines",
          status: "success",
          courseIds: ["16040"],
          categories: ["assignments"],
        },
        {
          id: "2",
          operation: "submissions",
          label: "Eigen inleverstatus",
          status: "running",
          courseIds: ["16040"],
          categories: ["submissions"],
        },
      ],
      true,
    );
    expect(whileRunning.summaryText).toBe("Canvas bekijken...");
    expect(whileRunning.tone).toBe("default");

    // When finished with a non-student course (not_applicable):
    const withNa = summarizeToolActivity(
      [
        {
          id: "1",
          operation: "assignments",
          label: "Opdrachten en deadlines",
          status: "success",
          courseIds: ["16040"],
          categories: ["assignments"],
        },
        {
          id: "2",
          operation: "submissions",
          label: "Eigen inleverstatus",
          status: "not_applicable",
          courseIds: ["16040"],
          categories: ["submissions"],
        },
      ],
      false,
    );
    expect(withNa.summaryText).toBe("Canvas bekeken · 1 gelezen, 1 niet van toepassing");
    expect(withNa.tone).toBe("warning");
    expect(withNa.badgeText).toBe("Deels n.v.t.");

    // When finished with a failure: collapsed header still indicates failure
    const withFail = summarizeToolActivity(
      [
        {
          id: "1",
          operation: "assignments",
          label: "Opdrachten en deadlines",
          status: "success",
          courseIds: ["16040"],
          categories: ["assignments"],
        },
        {
          id: "2",
          operation: "submissions",
          label: "Eigen inleverstatus",
          status: "failed",
          courseIds: ["16040"],
          categories: ["submissions"],
        },
      ],
      false,
    );
    expect(withFail.summaryText).toBe("Canvas bekeken · 1 gelezen, 1 mislukt");
    expect(withFail.tone).toBe("error");
    expect(withFail.badgeText).toBe("Fout / beperkt");
  });
});
