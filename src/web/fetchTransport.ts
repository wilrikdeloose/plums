import { TransportError, type HttpRequest, type HttpResponse, type HttpTransport } from "../core/platform";
import type { MemorySecretStore } from "./memorySecretStore";

function abortedError() {
  return new TransportError("aborted", "Het verzoek is gestopt.");
}

export class FetchTransport implements HttpTransport {
  constructor(
    private readonly secrets: MemorySecretStore,
    private readonly fetchFn: typeof fetch = (...args) => globalThis.fetch(...args),
  ) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      throw new TransportError("invalid-request", "Ongeldige URL.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new TransportError("invalid-request", "Alleen http(s) is toegestaan.");

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (name.toLowerCase() !== "authorization") headers[name] = value;
    }
    if (req.bearerFromSecret) {
      const secret = this.secrets.resolve(req.url);
      if (!secret) throw new TransportError("missing-secret", "Er is geen API-sleutel voor dit endpoint in deze browsersessie.");
      headers.authorization = `Bearer ${secret}`;
    }
    if (req.signal?.aborted) throw abortedError();

    let response: Response;
    try {
      response = await this.fetchFn(req.url, {
        method: req.method,
        headers,
        body: req.body,
        signal: req.signal,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
    } catch {
      if (req.signal?.aborted) throw abortedError();
      throw new TransportError(
        "network",
        `${url.host} is niet bereikbaar. Controleer de URL en je netwerk. In de browser moet de AI-dienst ook CORS toestaan voor deze pagina.`,
      );
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => (responseHeaders[name.toLowerCase()] = value));
    const signal = req.signal;

    async function* body(): AsyncGenerator<Uint8Array> {
      if (!response.body) return;
      const reader = response.body.getReader();
      let finished = false;
      try {
        while (true) {
          let result: ReadableStreamReadResult<Uint8Array>;
          try {
            result = await reader.read();
          } catch {
            finished = true;
            if (signal?.aborted) throw abortedError();
            throw new TransportError("stream", "De verbinding werd verbroken tijdens het antwoord.");
          }
          if (result.done) {
            finished = true;
            return;
          }
          if (result.value.byteLength > 0) yield result.value;
        }
      } finally {
        if (!finished) void reader.cancel().catch(() => undefined);
      }
    }

    return { status: response.status, headers: responseHeaders, body: body() };
  }
}
