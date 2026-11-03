import {
  Client,
  InsufficientScopeError,
  ProtocolError,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import {
  CanvasMcpError,
  type McpClient,
  type McpDiscoveryResult,
  type McpTargetConfig,
  type McpToolCallResult,
  type McpToolDescriptor,
} from "../core/mcp/types";
import { remoteMcpSecretKey } from "../core/mcp/url";
import type { MemorySecretStore } from "./memorySecretStore";

interface ActiveSession {
  endpointUrl: string;
  client: Client;
  transport: StreamableHTTPClientTransport;
}

function mapBrowserMcpError(error: unknown, endpointUrl: string): CanvasMcpError {
  if (error instanceof CanvasMcpError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new CanvasMcpError("aborted", "De MCP-bewerking is geannuleerd.");
  }
  if (error instanceof UnauthorizedError) {
    const msg = error.message.toLowerCase();
    if (msg.includes("oauth") || msg.includes("dpop") || msg.includes("resource_metadata")) {
      return new CanvasMcpError(
        "unsupported",
        `De externe MCP-server (${endpointUrl}) vereist interactieve OAuth/DPoP-authenticatie. PLuMS ondersteunt in deze versie alleen een optioneel Bearer-token.`,
      );
    }
    return new CanvasMcpError(
      "auth",
      `De externe MCP-server (${endpointUrl}) weigerde de toegang (401). Controleer het optionele MCP Bearer-token onder Instellingen → MCP.`,
    );
  }
  if (error instanceof InsufficientScopeError) {
    return new CanvasMcpError(
      "forbidden",
      `Onvoldoende rechten op de externe MCP-server (${endpointUrl}): vereiste scope ontbreekt.`,
    );
  }
  if (error instanceof SdkHttpError) {
    if (error.status === 401) {
      return new CanvasMcpError(
        "auth",
        `De externe MCP-server (${endpointUrl}) vereist authenticatie (HTTP 401). Controleer het optionele MCP Bearer-token.`,
      );
    }
    if (error.status === 403) {
      return new CanvasMcpError(
        "forbidden",
        `Geen toegang tot de externe MCP-server (${endpointUrl}, HTTP 403).`,
      );
    }
    if (error.status === 404) {
      return new CanvasMcpError(
        "not-found",
        `MCP-endpoint niet gevonden op ${endpointUrl} (HTTP 404).`,
      );
    }
    if (error.status === 429) {
      return new CanvasMcpError(
        "rate-limit",
        `Rate-limit bereikt bij de externe MCP-server (${endpointUrl}, HTTP 429).`,
      );
    }
    return new CanvasMcpError(
      "network",
      `De externe MCP-server (${endpointUrl}) gaf HTTP ${error.status} terug.`,
    );
  }
  if (error instanceof ProtocolError) {
    return new CanvasMcpError(
      "protocol",
      `MCP-protocolfout van ${endpointUrl}: ${error.message}`,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CanvasMcpError(
    "network",
    `Kan geen verbinding maken met de externe MCP-server (${endpointUrl}): ${message}. Controleer de URL, je netwerkverbinding en of de server CORS toestaat.`,
  );
}

/**
 * Browser MCP client using the official `@modelcontextprotocol/client` Streamable HTTP transport.
 * Supports protocol version negotiation (`auto`), JSON/SSE responses, cancellation, and clean session termination.
 * Never supports or launches a local server; never reads or forwards a Canvas token.
 */
export class BrowserRemoteMcpClient implements McpClient {
  private session: ActiveSession | null = null;

  constructor(
    private readonly secrets: MemorySecretStore,
    private readonly fetchFn?: typeof fetch,
  ) {}

  private async openSession(target: McpTargetConfig, signal?: AbortSignal): Promise<ActiveSession> {
    if (target.mode !== "remote") {
      throw new CanvasMcpError(
        "unsupported",
        "De browser ondersteunt alleen een externe MCP-server via Streamable HTTP (geen ingebouwde lokale server).",
      );
    }
    if (signal?.aborted) {
      throw new CanvasMcpError("aborted", "De MCP-verbinding is geannuleerd.");
    }

    await this.disconnect();

    let url: URL;
    try {
      url = new URL(target.endpointUrl);
    } catch {
      throw new CanvasMcpError("config", "Ongeldige externe MCP-URL.");
    }

    // Crucially: only looks up `mcp:<endpointUrl>`, NEVER `canvas:...` or `ai:...`
    const secretKey = remoteMcpSecretKey(target.endpointUrl);
    const token = this.secrets.resolve(secretKey);

    const transport = new StreamableHTTPClientTransport(url, {
      fetch: this.fetchFn,
      redirectPolicy: "same-origin",
      onInsufficientScope: "throw",
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
      authProvider: token
        ? {
            token: async () => this.secrets.resolve(secretKey),
          }
        : undefined,
    });

    const client = new Client(
      { name: "plums-web-client", version: "0.1.0" },
      { versionNegotiation: { mode: "auto" } },
    );

    const onAbort = () => {
      void client.close().catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await client.connect(transport);
      const active: ActiveSession = { endpointUrl: target.endpointUrl, client, transport };
      this.session = active;
      return active;
    } catch (error) {
      await client.close().catch(() => undefined);
      if (signal?.aborted) {
        throw new CanvasMcpError("aborted", "De MCP-verbinding is geannuleerd.");
      }
      throw mapBrowserMcpError(error, target.endpointUrl);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async discover(target: McpTargetConfig, signal?: AbortSignal): Promise<McpDiscoveryResult> {
    const active = await this.openSession(target, signal);
    try {
      const listRes = await active.client.listTools(undefined, { signal });
      const serverVersionObj = active.client.getServerVersion();
      const tools: McpToolDescriptor[] = (listRes.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema as unknown as Record<string, unknown>) ?? { type: "object" },
        annotations: t.annotations
          ? {
              readOnlyHint: t.annotations.readOnlyHint,
              destructiveHint: t.annotations.destructiveHint,
            }
          : undefined,
      }));

      return {
        serverName: serverVersionObj?.name ?? "Externe MCP-server",
        serverVersion: serverVersionObj?.version ?? "",
        protocolVersion: active.transport.protocolVersion ?? "auto",
        tools,
      };
    } catch (error) {
      if (signal?.aborted) {
        throw new CanvasMcpError("aborted", "De MCP-ontdekking is geannuleerd.");
      }
      throw mapBrowserMcpError(error, target.endpointUrl);
    }
  }

  async callTool(
    target: McpTargetConfig,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult> {
    let active = this.session;
    if (!active || active.endpointUrl !== target.endpointUrl) {
      active = await this.openSession(target, signal);
    }

    try {
      const result = await active.client.callTool(
        { name: toolName, arguments: args },
        { signal },
      );
      const contentArr = Array.isArray(result.content) ? result.content : [];
      const textParts: string[] = [];
      for (const item of contentArr) {
        if (
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "text" &&
          "text" in item &&
          typeof item.text === "string"
        ) {
          textParts.push(item.text);
        }
      }
      return {
        isError: result.isError === true,
        structuredContent: "structuredContent" in result ? result.structuredContent : undefined,
        textContent: textParts.join("\n").trim(),
      };
    } catch (error) {
      if (signal?.aborted) {
        throw new CanvasMcpError("aborted", "De MCP-aanroep is geannuleerd.");
      }
      throw mapBrowserMcpError(error, target.endpointUrl);
    }
  }

  async disconnect(): Promise<void> {
    const active = this.session;
    this.session = null;
    if (!active) return;
    await active.transport.terminateSession().catch(() => undefined);
    await active.client.close().catch(() => undefined);
  }
}
