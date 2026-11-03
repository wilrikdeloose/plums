import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownProps {
  text: string;
  /**
   * Optional allowlist of retrieved source URLs for this assistant message.
   * When provided, links are clickable ONLY if their URL matches one of the
   * actual retrieved Canvas sources; invented or unverified links are rendered
   * as plain text so the model can never invent clickable links.
   */
  allowedUrls?: readonly string[];
}

function normalizeUrlForComparison(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return raw.trim();
  }
}

/** Raw HTML is never rendered (no rehype-raw); unsafe link protocols and unverified URLs are rendered as plain text. */
export const Markdown = memo(function Markdown({ text, allowedUrls }: MarkdownProps) {
  const allowedSet = useMemo(() => {
    if (!allowedUrls) return null;
    const set = new Set<string>();
    for (const u of allowedUrls) {
      if (u && u.trim()) set.add(normalizeUrlForComparison(u));
    }
    return set;
  }, [allowedUrls]);

  const components: Components = useMemo(
    () => ({
      a: ({ href, children }) => {
        if (!href) return <span>{children}</span>;
        const normalized = normalizeUrlForComparison(href);
        if (allowedSet !== null && !allowedSet.has(normalized)) {
          return <span className="unverified-link">{children}</span>;
        }
        return (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      },
      img: ({ alt }) => <span className="muted">[afbeelding{alt ? `: ${alt}` : ""}]</span>,
      table: ({ children }) => (
        <div className="table-wrap">
          <table>{children}</table>
        </div>
      ),
    }),
    [allowedSet],
  );

  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
});
