const CHAT_PATH = "/chat/completions";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type EndpointResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * Turns an OpenAI-compatible base URL into its chat completions URL: trailing slashes are removed
 * and /chat/completions is appended exactly once. Query strings (e.g. api-version) are kept.
 * Plain http is only accepted for loopback hosts, so keys never travel unencrypted.
 */
export function chatCompletionsUrl(baseUrl: string): EndpointResult {
  const input = baseUrl.trim();
  if (!input) return { ok: false, error: "Vul een basis-URL in." };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: "Dit is geen geldige URL." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "Gebruik een http(s)-URL." };
  }
  if (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) {
    return { ok: false, error: "Gebruik https; http is alleen toegestaan voor localhost." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Zet geen inloggegevens in de URL; gebruik het API-sleutelveld." };
  }
  url.hash = "";
  let path = url.pathname.replace(/\/+$/, "");
  if (!path.toLowerCase().endsWith(CHAT_PATH)) path += CHAT_PATH;
  url.pathname = path;
  return { ok: true, url: url.toString() };
}
