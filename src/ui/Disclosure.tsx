import { type ReactNode, useId, useState } from "react";
import { IconChevronDown } from "./icons";

export interface DisclosureProps {
  /** Text or inline elements rendered inside the toggle button. */
  summary: ReactNode;
  /** Optional tone indicator shown on the collapsed/expanded header when issues or partial results exist. */
  tone?: "default" | "warning" | "error";
  /** Optional status badge rendered next to the summary on the toggle header. */
  badge?: ReactNode;
  /** Optional className for the outer container. */
  className?: string;
  /** Accessibility label for the content region. */
  regionLabel?: string;
  /** Controlled or initial open state (defaults to false — collapsed by default). */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * Shared accessible disclosure component for desktop and web.
 * Starts collapsed (`false`) by default and preserves the user's explicit toggle choice
 * across streaming updates without auto-expanding on new calls, errors, or completion.
 */
export function Disclosure({
  summary,
  tone = "default",
  badge,
  className = "",
  regionLabel,
  defaultOpen = false,
  children,
}: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const buttonId = useId();

  return (
    <div
      className={`disclosure tone-${tone} ${open ? "is-open" : "is-closed"} ${className}`.trim()}
    >
      <button
        id={buttonId}
        type="button"
        className="disclosure-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="disclosure-summary">{summary}</span>
        {badge && <span className="disclosure-badge">{badge}</span>}
        <span className={`disclosure-chevron ${open ? "open" : ""}`} aria-hidden="true">
          <IconChevronDown />
        </span>
      </button>
      <div
        id={panelId}
        role="region"
        aria-labelledby={buttonId}
        aria-label={regionLabel}
        className="disclosure-panel"
        hidden={!open}
      >
        {open && children}
      </div>
    </div>
  );
}
