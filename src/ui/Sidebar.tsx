import { useState } from "react";
import { deleteConversation, renameConversation, sortedConversations } from "../core/conversations";
import type { Conversation } from "../core/schema";
import { useConfirm } from "./Confirm";
import { useRunning, useServices, useSnapshot } from "./context";
import { IconNewChat, IconPencil, IconTrash } from "./icons";
import { SaveStatus } from "./SaveStatus";

interface Props {
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
}

export function Sidebar({ activeId, onSelect, onNewChat, onOpenSettings }: Props) {
  const { data } = useSnapshot();
  const { controller, runner } = useServices();
  const running = useRunning();
  const confirm = useConfirm();
  const [editingId, setEditingId] = useState<string | null>(null);
  if (!data) return null;

  const remove = async (conversation: Conversation) => {
    const ok = await confirm({
      title: "Chat verwijderen?",
      message: `"${conversation.title}" en alle berichten worden definitief verwijderd.`,
      confirmLabel: "Verwijderen",
      danger: true,
    });
    if (!ok) return;
    runner.cancel(conversation.id);
    controller.update((d) => deleteConversation(d, conversation.id), { immediate: true });
    if (conversation.id === activeId) onNewChat();
  };

  const name = data.profile.name.trim();

  return (
    <aside className="sidebar">
      <div className="brand">
        <img src="/plums.svg" alt="" width={28} height={28} />
        <span>PLuMS</span>
      </div>
      <button className="new-chat" onClick={onNewChat}>
        <IconNewChat /> Nieuwe chat
      </button>
      <nav className="history" aria-label="Gespreksgeschiedenis">
        {data.conversations.length === 0 && <p className="muted small">Nog geen gesprekken.</p>}
        {sortedConversations(data).map((c) =>
          editingId === c.id ? (
            <RenameField
              key={c.id}
              initial={c.title}
              onDone={(title) => {
                setEditingId(null);
                if (title !== null && title.trim() && title.trim() !== c.title) {
                  controller.update((d) => renameConversation(d, c.id, title), { immediate: true });
                }
              }}
            />
          ) : (
            <div key={c.id} className={c.id === activeId ? "history-item active" : "history-item"}>
              <button className="history-open" onClick={() => onSelect(c.id)} title={c.title}>
                {running.has(c.id) && <span className="running-dot" aria-label="Antwoord wordt geschreven" />}
                {c.title}
              </button>
              <button className="icon-button" aria-label={`"${c.title}" hernoemen`} title="Hernoemen" onClick={() => setEditingId(c.id)}>
                <IconPencil />
              </button>
              <button className="icon-button" aria-label={`"${c.title}" verwijderen`} title="Verwijderen" onClick={() => void remove(c)}>
                <IconTrash />
              </button>
            </div>
          ),
        )}
      </nav>
      <div className="sidebar-footer">
        <SaveStatus />
        <button className="profile-button" onClick={onOpenSettings}>
          <span className="avatar">{(name[0] ?? "?").toUpperCase()}</span>
          <span className="profile-text">
            <span>{name || "Profiel"}</span>
            <span className="muted small">Profiel en instellingen</span>
          </span>
        </button>
      </div>
    </aside>
  );
}

function RenameField({ initial, onDone }: { initial: string; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <input
      className="rename-input"
      aria-label="Nieuwe naam voor chat"
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => onDone(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(value);
        if (e.key === "Escape") onDone(null);
      }}
    />
  );
}
