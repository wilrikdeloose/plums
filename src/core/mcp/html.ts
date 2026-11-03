const BLOCK_TAGS = /^(p|div|section|article|header|footer|aside|blockquote|pre|h[1-6]|ul|ol|li|tr|table|hr|br)$/i;
const SKIP_CONTENT_TAGS = new Set(["script", "style", "noscript", "svg", "head", "iframe", "object", "embed"]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  euro: "€",
  copy: "©",
  reg: "®",
  trade: "™",
  bull: "•",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ë: "ë",
  ï: "ï",
  é: "é",
  è: "è",
  ê: "ê",
  ü: "ü",
  ö: "ö",
  ä: "ä",
  á: "á",
  à: "à",
  ó: "ó",
  ò: "ò",
  ú: "ú",
  ñ: "ñ",
  ç: "ç",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z0-9]+);/g, (full, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        return String.fromCodePoint(code);
      }
      return full;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        return String.fromCodePoint(code);
      }
      return full;
    }
    const lower = entity.toLowerCase();
    return NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[lower] ?? full;
  });
}

/**
 * Safely converts Canvas HTML fragments (descriptions, announcements, wiki pages) into clean plain text.
 * Strips `<script>`, `<style>`, comments, and all HTML tags without executing or rendering any markup.
 */
export function htmlToPlainText(html: string | null | undefined, maxChars = 8_000): string {
  if (!html || typeof html !== "string") return "";

  let s = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of SKIP_CONTENT_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    s = s.replace(re, "");
  }

  s = s.replace(/<(\/)?([a-zA-Z0-9:-]+)(?:\s[^>]*)?>/g, (_match, closing: string | undefined, rawName: string) => {
    const name = rawName.toLowerCase();
    if (name === "li") return closing ? "\n" : "\n• ";
    if (name === "td" || name === "th") return closing ? "" : " \t ";
    if (BLOCK_TAGS.test(name)) return "\n";
    return "";
  });

  s = decodeEntities(s);
  s = s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \f\v]+/g, " ")
    .replace(/ *\t */g, " | ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (s.length > maxChars) {
    return `${s.slice(0, maxChars - 1).trimEnd()}…`;
  }
  return s;
}
