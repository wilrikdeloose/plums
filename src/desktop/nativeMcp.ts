import { invoke } from "@tauri-apps/api/core";
import {
  CanvasMcpError,
  type McpClient,
  type McpDiscoveryResult,
  type McpErrorKind,
  type McpTargetConfig,
  type McpToolCallResult,
} from "../core/mcp/types";

function mapNativeMcpError(error: unknown): CanvasMcpError {
  if (error instanceof CanvasMcpError) return error;
  const e = error as { kind?: McpErrorKind; message?: unknown };
  const kind: McpErrorKind = e?.kind ?? "network";
  const message = typeof e?.message === "string" ? e.message : String(error);
  return new CanvasMcpError(kind, message);
}

/**
 * Desktop MCP client bridged through Tauri IPC to Rust `rmcp`.
 * Supports both `builtin` (in-process duplex `rmcp` server + client) and `remote` (Streamable HTTP `rmcp` client).
 * Secrets remain inside the OS credential store and are resolved in Rust only.
 */
export class NativeMcpClient implements McpClient {
  async discover(target: McpTargetConfig, signal?: AbortSignal): Promise<McpDiscoveryResult> {
    if (signal?.aborted) {
      throw new CanvasMcpError("aborted", "De MCP-verbinding is geannuleerd.");
    }
    const callId = crypto.randomUUID();
    const onAbort = () => {
      void invoke("mcp_cancel", { callId }).catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      return await invoke<McpDiscoveryResult>("mcp_discover", {
        callId,
        target,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new CanvasMcpError("aborted", "De MCP-verbinding is geannuleerd.");
      }
      throw mapNativeMcpError(error);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async callTool(
    target: McpTargetConfig,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult> {
    if (signal?.aborted) {
      throw new CanvasMcpError("aborted", "De MCP-aanroep is geannuleerd.");
    }
    const callId = crypto.randomUUID();
    const onAbort = () => {
      void invoke("mcp_cancel", { callId }).catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      return await invoke<McpToolCallResult>("mcp_call_tool", {
        callId,
        target,
        toolName,
        args,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new CanvasMcpError("aborted", "De MCP-aanroep is geannuleerd.");
      }
      throw mapNativeMcpError(error);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async disconnect(): Promise<void> {
    await invoke("mcp_disconnect").catch(() => undefined);
  }
}
