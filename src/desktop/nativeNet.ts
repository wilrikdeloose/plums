import { Channel, invoke } from "@tauri-apps/api/core";
import {
  SecretError,
  TransportError,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  type SecretStore,
  type TransportErrorKind,
} from "../core/platform";

function nativeMessage(error: unknown): string {
  const e = error as { message?: unknown };
  return typeof e?.message === "string" ? e.message : String(error);
}

/** Keys go to the OS credential store via Rust (Windows Credential Manager / macOS Keychain) and are never read back here. */
export class OsSecretStore implements SecretStore {
  readonly persistence = "os" as const;

  async has(endpoint: string): Promise<boolean> {
    try {
      return await invoke<boolean>("secret_status", { endpoint });
    } catch (error) {
      throw new SecretError(nativeMessage(error));
    }
  }

  async save(endpoint: string, secret: string): Promise<void> {
    try {
      await invoke<void>("secret_save", { endpoint, secret });
    } catch (error) {
      throw new SecretError(nativeMessage(error));
    }
  }

  async remove(endpoint: string): Promise<void> {
    try {
      await invoke<void>("secret_remove", { endpoint });
    } catch (error) {
      throw new SecretError(nativeMessage(error));
    }
  }
}

type NativeHttpEvent =
  | { type: "head"; status: number; headers: [string, string][] }
  | { type: "chunk"; data: number[] }
  | { type: "end" }
  | { type: "error"; kind: TransportErrorKind; message: string };

/** HTTP through Rust (reqwest); the bearer secret is resolved natively and never enters JavaScript. */
export class NativeHttpTransport implements HttpTransport {
  async request(req: HttpRequest): Promise<HttpResponse> {
    if (req.signal?.aborted) throw new TransportError("aborted", "Het verzoek is gestopt.");
    const id = crypto.randomUUID();
    const channel = new Channel<NativeHttpEvent>();
    const queue: Uint8Array[] = [];
    let ended = false;
    let failure: TransportError | null = null;
    let wake: (() => void) | null = null;
    let settleHead: { resolve: (r: { status: number; headers: Record<string, string> }) => void; reject: (e: unknown) => void } | null = null;
    const head = new Promise<{ status: number; headers: Record<string, string> }>((resolve, reject) => (settleHead = { resolve, reject }));
    const notify = () => {
      wake?.();
      wake = null;
    };
    const fail = (error: TransportError) => {
      if (ended || failure) return;
      failure = error;
      settleHead?.reject(error);
      notify();
    };

    channel.onmessage = (event) => {
      switch (event.type) {
        case "head":
          settleHead?.resolve({ status: event.status, headers: Object.fromEntries(event.headers.map(([k, v]) => [k.toLowerCase(), v])) });
          break;
        case "chunk":
          queue.push(Uint8Array.from(event.data));
          notify();
          break;
        case "end":
          ended = true;
          notify();
          break;
        case "error":
          fail(new TransportError(event.kind, event.message));
          break;
      }
    };

    const cancel = () => void invoke("http_cancel", { id }).catch(() => undefined);
    const onAbort = () => {
      cancel();
      fail(new TransportError("aborted", "Het verzoek is gestopt."));
    };
    req.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await invoke("http_start", {
        id,
        request: {
          url: req.url,
          method: req.method,
          headers: Object.entries(req.headers),
          body: req.body ?? null,
          bearerFromSecret: req.bearerFromSecret ?? false,
        },
        onEvent: channel,
      });
    } catch (error) {
      req.signal?.removeEventListener("abort", onAbort);
      const e = error as { kind?: TransportErrorKind };
      throw new TransportError(e?.kind ?? "network", nativeMessage(error));
    }

    let status: { status: number; headers: Record<string, string> };
    try {
      status = await head;
    } catch (error) {
      req.signal?.removeEventListener("abort", onAbort);
      throw error;
    }

    async function* body(): AsyncGenerator<Uint8Array> {
      try {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift()!;
            continue;
          }
          if (failure) throw failure;
          if (ended) return;
          await new Promise<void>((resolve) => (wake = resolve));
        }
      } finally {
        req.signal?.removeEventListener("abort", onAbort);
        if (!ended) cancel();
      }
    }

    return { ...status, body: body() };
  }
}
