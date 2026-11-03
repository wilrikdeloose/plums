export type EndpointResult = { ok: true; url: string; origin: string } | { ok: false; error: string };

function parseSafeHttpUrl(raw: string, emptyMessage: string): { ok: true; url: URL } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: emptyMessage };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "Dit is geen geldige URL." };
  }

  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return { ok: false, error: "Gebruik https (http is alleen toegestaan voor localhost)." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Zet geen inloggegevens of tokens in de URL." };
  }
  url.hash = "";
  return { ok: true, url };
}

/**
 * Normalizes a Canvas instance base URL (e.g. `https://fhict.instructure.com`).
 * Strips `/api/v1` and trailing slashes so credentials and origin checks bind to the canonical Canvas base URL.
 */
export function normalizeCanvasBaseUrl(raw: string): EndpointResult {
  const parsed = parseSafeHttpUrl(raw, "Vul de basis-URL van Canvas in.");
  if (!parsed.ok) return parsed;
  const { url } = parsed;
  if (url.search) {
    return { ok: false, error: "De Canvas basis-URL mag geen queryparameters bevatten." };
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (path.toLowerCase().endsWith("/api/v1")) {
    path = path.slice(0, -"/api/v1".length).replace(/\/+$/, "");
  }
  url.pathname = path || "/";
  const normalized = url.toString().replace(/\/$/, "");
  return { ok: true, url: normalized, origin: url.origin };
}

/**
 * Normalizes a remote Streamable HTTP MCP URL (e.g. `https://mcp.example.com/mcp`).
 * Strips trailing slashes (except root) and rejects embedded credentials.
 */
export function normalizeRemoteMcpUrl(raw: string): EndpointResult {
  const parsed = parseSafeHttpUrl(raw, "Vul de externe MCP-URL in.");
  if (!parsed.ok) return parsed;
  const { url } = parsed;
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path || "/";
  const formatted = path ? url.toString() : url.toString().replace(/\/$/, "");
  return { ok: true, url: formatted, origin: url.origin };
}

export function canvasSecretKey(normalizedCanvasBaseUrl: string): string {
  return `canvas:${normalizedCanvasBaseUrl}`;
}

export function remoteMcpSecretKey(normalizedRemoteMcpUrl: string): string {
  return `mcp:${normalizedRemoteMcpUrl}`;
}

/**
 * Checks that a Canvas web link or pagination URL belongs to the configured Canvas origin.
 * Returns null if the link is invalid or points to another origin.
 */
export function validateSameOriginUrl(candidate: string | null | undefined, expectedOrigin: string): string | null {
  if (!candidate || typeof candidate !== "string") return null;
  try {
    const parsed = new URL(candidate, expectedOrigin);
    if (parsed.origin !== expectedOrigin) return null;
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}
