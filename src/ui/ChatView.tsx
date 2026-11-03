import { useEffect, useRef, useState } from "react";
import { CATEGORY_LABELS } from "../core/mcp/types";
import type {
  Conversation,
  Message,
  ToolStep,
  ToolStepStatus,
} from "../core/schema";
import { useCanvasSnapshot, useRunning, useServices, useSnapshot } from "./context";
import { Disclosure } from "./Disclosure";
import { IconCheck, IconCopy, IconPencil, IconRefresh, IconSend, IconStop } from "./icons";
import { Markdown } from "./Markdown";
import { PlanTable } from "./PlanTable";

export const STARTER_QUESTIONS = [
  "Help me mijn dag te plannen.",
  "Help me mijn week te plannen.",
  "Welke deadlines moet ik nu in de gaten houden?",
  "Welke announcements zijn relevant voor mij?",
];

const STEP_STATUS_LABELS: Record<ToolStepStatus, string> = {
  running: "Bezig…",
  success: "Gelezen",
  empty: "Geen items",
  partial: "Gedeeltelijk",
  not_applicable: "Niet van toepassing",
  denied: "Geweigerd",
  failed: "Mislukt",
  cancelled: "Geannuleerd",
};

interface Props {
  conversation: Conversation | null;
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: () => void;
}

function connectionProblemNotice(
  canvasSnap: ReturnType<typeof useCanvasSnapshot>,
): string | null {
  if (canvasSnap.status === "error" && canvasSnap.errorMessage) {
    return `Ik kan je Canvas-cursussen nu even niet bekijken: ${canvasSnap.errorMessage}`;
  }
  return null;
}

export function summarizeToolActivity(
  steps: readonly ToolStep[],
  isMessageStreaming: boolean,
): {
  summaryText: string;
  tone: "default" | "warning" | "error";
  badgeText?: string;
} {
  const anyRunning = steps.some((s) => s.status === "running");
  const okCount = steps.filter((s) => s.status === "success" || s.status === "empty").length;
  const partialCount = steps.filter((s) => s.status === "partial").length;
  const naCount = steps.filter((s) => s.status === "not_applicable").length;
  const deniedCount = steps.filter((s) => s.status === "denied").length;
  const failedCount = steps.filter((s) => s.status === "failed").length;
  const cancelledCount = steps.filter((s) => s.status === "cancelled").length;

  const hasError = failedCount > 0 || deniedCount > 0;
  const hasWarning = partialCount > 0 || naCount > 0 || cancelledCount > 0;
  const tone: "default" | "warning" | "error" = hasError
    ? "error"
    : hasWarning
      ? "warning"
      : "default";

  const issueParts: string[] = [];
  if (failedCount > 0) issueParts.push(`${failedCount} mislukt`);
  if (deniedCount > 0) issueParts.push(`${deniedCount} geweigerd`);
  if (partialCount > 0) issueParts.push(`${partialCount} gedeeltelijk`);
  if (naCount > 0) issueParts.push(`${naCount} niet van toepassing`);
  if (cancelledCount > 0) issueParts.push(`${cancelledCount} afgebroken`);

  const planningOps = new Set(["plan_create", "plan_revise", "planning_clarify"]);
  const hasPlanning = steps.some((s) => planningOps.has(s.operation));
  const hasCanvas = steps.some((s) => !planningOps.has(s.operation));

  if (anyRunning || (isMessageStreaming && steps.length === 0)) {
    return {
      summaryText: hasPlanning && !hasCanvas ? "Planning maken..." : "Canvas bekijken...",
      tone,
      badgeText: issueParts.length > 0 ? issueParts.join(", ") : undefined,
    };
  }

  const summaryParts: string[] = [];
  if (okCount > 0) summaryParts.push(`${okCount} gelezen`);
  summaryParts.push(...issueParts);

  const detail = summaryParts.length > 0 ? summaryParts.join(", ") : `${steps.length} stap(pen)`;
  const head =
    hasCanvas && hasPlanning
      ? "Canvas bekeken & planning gemaakt"
      : hasPlanning
        ? "Planning"
        : "Canvas bekeken";
  return {
    summaryText: `${head} · ${detail}`,
    tone,
    badgeText: hasError
      ? "Fout / beperkt"
      : partialCount > 0
        ? "Gedeeltelijk"
        : naCount > 0
          ? "Deels n.v.t."
          : undefined,
  };
}

export function ChatView({ conversation, draft, onDraftChange, onSend }: Props) {
  const { runner } = useServices();
  const canvasSnap = useCanvasSnapshot();
  const running = useRunning();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const savedDraftBeforeEdit = useRef<string>("");

  const last = conversation?.messages[conversation.messages.length - 1];
  const isRunning = conversation ? running.has(conversation.id) : false;
  const noticeText = connectionProblemNotice(canvasSnap);

  // Reset edit mode when switching conversations
  useEffect(() => {
    setEditingMessageId(null);
    savedDraftBeforeEdit.current = "";
    stickToBottom.current = true;
  }, [conversation?.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [
    conversation?.id,
    conversation?.messages.length,
    last?.content.length,
    last?.status,
    last?.toolSteps?.length,
  ]);

  if (!conversation) {
    return (
      <div className="empty-chat">
        <h1>Waarmee kan ik je helpen?</h1>
        <Composer
          value={draft}
          onChange={onDraftChange}
          onSend={onSend}
          running={false}
          onStop={() => undefined}
        />
        <div className="starters">
          {STARTER_QUESTIONS.map((q) => (
            <button key={q} className="starter" onClick={() => onDraftChange(q)}>
              {q}
            </button>
          ))}
        </div>
        {noticeText && <p className="notice">{noticeText}</p>}
      </div>
    );
  }

  // Find the latest user message in this conversation (only this message gets the edit pencil in the PoC)
  let latestUserMessageId: string | null = null;
  for (let i = conversation.messages.length - 1; i >= 0; i--) {
    if (conversation.messages[i].role === "user") {
      latestUserMessageId = conversation.messages[i].id;
      break;
    }
  }

  const startEditingLatestUser = (msg: Message) => {
    if (isRunning) return;
    if (!editingMessageId) {
      savedDraftBeforeEdit.current = draft;
    }
    setEditingMessageId(msg.id);
    onDraftChange(msg.content);
  };

  const cancelEditing = () => {
    setEditingMessageId(null);
    onDraftChange(savedDraftBeforeEdit.current);
    savedDraftBeforeEdit.current = "";
  };

  const submitComposer = () => {
    if (editingMessageId && editingMessageId === latestUserMessageId) {
      const ok = runner.editLatestUserMessage(conversation.id, editingMessageId, draft);
      if (ok) {
        setEditingMessageId(null);
        savedDraftBeforeEdit.current = "";
        onDraftChange("");
      }
      return;
    }
    onSend();
  };

  return (
    <div className="chat">
      <div
        className="messages"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="messages-inner">
          {conversation.messages.map((m) => (
            <MessageView
              key={m.id}
              message={m}
              isLatestUser={m.role === "user" && m.id === latestUserMessageId}
              isEditingThis={m.id === editingMessageId}
              conversationRunning={isRunning}
              onEditUserMessage={() => startEditingLatestUser(m)}
              onRegenerateAssistant={() => runner.retry(conversation.id, m.id)}
            />
          ))}
        </div>
      </div>
      <div className="composer-dock">
        <Composer
          value={draft}
          onChange={onDraftChange}
          onSend={submitComposer}
          running={isRunning}
          onStop={() => runner.stop(conversation.id)}
          editing={editingMessageId !== null && editingMessageId === latestUserMessageId}
          onCancelEdit={cancelEditing}
        />
        {noticeText && <p className="notice">{noticeText}</p>}
      </div>
    </div>
  );
}

function ToolStepsDisclosure({
  steps,
  streaming,
}: {
  steps: readonly ToolStep[];
  streaming: boolean;
}) {
  if (steps.length === 0) return null;
  const { summaryText, tone, badgeText } = summarizeToolActivity(steps, streaming);

  return (
    <Disclosure
      summary={summaryText}
      tone={tone}
      badge={badgeText}
      className="tool-steps-disclosure"
      regionLabel="Canvas-activiteit"
    >
      <div className="tool-steps">
        {steps.map((step) => (
          <div key={step.id} className={`tool-step status-${step.status}`}>
            <span className="tool-step-badge">{STEP_STATUS_LABELS[step.status]}</span>
            <span className="tool-step-label">{step.label}</span>
            {step.testStudent && <span className="test-badge">Canvas Test Student</span>}
            {step.detail && <span className="tool-step-detail">— {step.detail}</span>}
          </div>
        ))}
      </div>
    </Disclosure>
  );
}

interface MessageViewProps {
  message: Message;
  isLatestUser: boolean;
  isEditingThis: boolean;
  conversationRunning: boolean;
  onEditUserMessage: () => void;
  onRegenerateAssistant: () => void;
}

function MessageView({
  message: m,
  isLatestUser,
  isEditingThis,
  conversationRunning,
  onEditUserMessage,
  onRegenerateAssistant,
}: MessageViewProps) {
  const [copied, setCopied] = useState(false);
  const { platform } = useServices();
  const { data } = useSnapshot();
  const linkedPlan = m.planId ? data?.plans.find((p) => p.id === m.planId) : undefined;

  if (m.role === "user") {
    return (
      <div className={`message user ${isEditingThis ? "editing" : ""}`}>
        <div className="user-message-stack">
          <div className="bubble">{m.content}</div>
          {isLatestUser && !conversationRunning && (
            <div className="message-toolbar user-toolbar" role="toolbar" aria-label="Berichtacties">
              <button
                type="button"
                className="toolbar-icon-button"
                onClick={onEditUserMessage}
                aria-label="Bericht bewerken"
                title="Bericht bewerken"
              >
                <IconPencil />
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const streaming = m.status === "streaming";
  const toolSteps = m.toolSteps ?? [];
  const sources = m.sources ?? [];
  const allowedUrls = sources
    .map((s) => s.url)
    .filter((u): u is string => typeof u === "string" && u.trim().length > 0);

  const handleCopy = async () => {
    if (!m.content) return;
    try {
      await navigator.clipboard.writeText(m.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore if clipboard is unavailable
    }
  };

  return (
    <div className={`message assistant ${m.status ?? "completed"}`}>
      <div className="bubble">
        {(m.canvasProvenance?.testStudentCourseIds?.length ?? 0) > 0 && (
          <p className="test-badge">
            Testgegevens: gebaseerd op de Canvas Test Student
            {platform.capabilities.canvasTestStudent ? "" : " (wordt in deze versie niet als context gebruikt)"}
          </p>
        )}
        {toolSteps.length > 0 && <ToolStepsDisclosure steps={toolSteps} streaming={streaming} />}
        {linkedPlan && <PlanTable plan={linkedPlan} />}
        {m.content ? (
          <Markdown text={m.content} allowedUrls={allowedUrls} />
        ) : streaming ? (
          <span className="typing" aria-label="PLuMS schrijft een antwoord">
            {toolSteps.some((s) => s.status === "running")
              ? "Even Canvas bekijken…"
              : "PLuMS denkt na…"}
          </span>
        ) : null}
        {streaming && m.content && <span className="cursor" aria-hidden="true" />}
        {sources.length > 0 && (
          <Disclosure
            summary={`Bronnen (${sources.length})`}
            className="message-sources-disclosure"
            regionLabel="Geraadpleegde Canvas-bronnen"
          >
            <ul className="message-sources-list">
              {sources.map((src) => (
                <li key={src.id} className="message-source-item">
                  <span className="source-category">{CATEGORY_LABELS[src.category]}</span>
                  {src.testStudent && <span className="test-badge">Canvas Test Student</span>}
                  {src.courseName && <span className="source-course">{src.courseName}:</span>}
                  {src.url ? (
                    <a href={src.url} target="_blank" rel="noopener noreferrer">
                      {src.title}
                    </a>
                  ) : (
                    <span>{src.title}</span>
                  )}
                  {src.dueAt && (
                    <span className="source-due">
                      (deadline:{" "}
                      {new Date(src.dueAt).toLocaleString("nl-NL", {
                        timeZone: "Europe/Amsterdam",
                      })}
                      )
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
        {m.status === "stopped" && (
          <p className="reply-note">{m.error ?? "Gestopt. Dit antwoord is onvolledig."}</p>
        )}
        {m.status === "failed" && (
          <p className="reply-error" role="alert">
            {m.content ? "Dit antwoord is onvolledig. " : ""}
            {m.error ?? "Er ging iets mis."}
          </p>
        )}
        {!streaming && (
          <div
            className="message-toolbar assistant-toolbar"
            role="toolbar"
            aria-label="Antwoordacties"
          >
            {m.content.trim().length > 0 && (
              <button
                type="button"
                className={`toolbar-icon-button ${copied ? "copied" : ""}`}
                onClick={() => void handleCopy()}
                aria-label={copied ? "Gekopieerd" : "Antwoord kopiëren"}
                title={copied ? "Gekopieerd" : "Antwoord kopiëren"}
              >
                {copied ? <IconCheck /> : <IconCopy />}
                {copied && (
                  <span className="toolbar-feedback" role="status" aria-live="polite">
                    Gekopieerd
                  </span>
                )}
              </button>
            )}
            <button
              type="button"
              className="toolbar-icon-button"
              onClick={onRegenerateAssistant}
              disabled={conversationRunning}
              aria-label="Antwoord opnieuw genereren"
              title="Antwoord opnieuw genereren"
            >
              <IconRefresh />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  running: boolean;
  onStop: () => void;
  editing?: boolean;
  onCancelEdit?: () => void;
}

function Composer({
  value,
  onChange,
  onSend,
  running,
  onStop,
  editing = false,
  onCancelEdit,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  useEffect(() => {
    if (value || editing) ref.current?.focus();
  }, [value, editing]);

  return (
    <div className="composer-wrapper">
      {editing && (
        <div className="composer-edit-banner">
          <span>Laatste bericht bewerken — opslaan genereert het antwoord opnieuw</span>
          <div className="composer-edit-actions">
            <button type="button" className="button small-button" onClick={onCancelEdit}>
              Annuleren
            </button>
            <button
              type="button"
              className="button primary small-button"
              disabled={!value.trim() || running}
              onClick={() => {
                if (!running && value.trim()) onSend();
              }}
            >
              Opslaan en opnieuw genereren
            </button>
          </div>
        </div>
      )}
      <form
        className={`composer ${editing ? "editing" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          if (!running) onSend();
        }}
      >
        <textarea
          ref={ref}
          rows={1}
          value={value}
          placeholder={editing ? "Bewerk je bericht…" : "Stel een vraag aan PLuMS…"}
          aria-label={editing ? "Bericht bewerken" : "Bericht"}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && editing && onCancelEdit) {
              e.preventDefault();
              onCancelEdit();
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!running) onSend();
            }
          }}
        />
        {running ? (
          <button
            type="button"
            className="send-button stop"
            onClick={onStop}
            aria-label="Stoppen"
            title="Stoppen"
          >
            <IconStop />
          </button>
        ) : (
          <button
            type="submit"
            className="send-button"
            disabled={!value.trim()}
            aria-label={editing ? "Opslaan en opnieuw genereren" : "Versturen"}
            title={editing ? "Opslaan en opnieuw genereren (Enter)" : "Versturen (Enter)"}
          >
            <IconSend />
          </button>
        )}
      </form>
    </div>
  );
}
