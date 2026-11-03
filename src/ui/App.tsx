import { useState } from "react";
import { ChatView } from "./ChatView";
import { useConfirm } from "./Confirm";
import { useServices, useSnapshot } from "./context";
import { SettingsDialog } from "./Settings";
import { Sidebar } from "./Sidebar";
import { TEST_BUILD } from "./testBuild";
import { TestBuildBanner } from "./TestStudentSettings";

export function App() {
  const snapshot = useSnapshot();
  const { runner } = useServices();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  if (snapshot.load.status === "loading") {
    return <div className="center-screen">Gegevens laden…</div>;
  }
  if (snapshot.load.status === "failed" || !snapshot.data) {
    return <LoadFailure />;
  }

  const data = snapshot.data;
  const active = data.conversations.find((c) => c.id === activeId) ?? null;

  const send = () => {
    const id = runner.send(active?.id ?? null, draft);
    if (!id) return;
    setActiveId(id);
    setDraft("");
  };

  return (
    <div className="app">
      <Sidebar
        activeId={active?.id ?? null}
        onSelect={(id) => {
          setActiveId(id);
          setDraft("");
        }}
        onNewChat={() => {
          setActiveId(null);
          setDraft("");
        }}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="main">
        {TEST_BUILD && <TestBuildBanner />}
        <ChatView conversation={active} draft={draft} onDraftChange={setDraft} onSend={send} />
      </main>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function LoadFailure() {
  const snapshot = useSnapshot();
  const { controller } = useServices();
  const confirm = useConfirm();
  const [message, setMessage] = useState<string | null>(null);
  const load = snapshot.load.status === "failed" ? snapshot.load : null;

  const startFresh = async () => {
    const ok = await confirm({
      title: "Nieuw beginnen?",
      message: "De huidige, onleesbare gegevens worden niet verwijderd maar apart gezet. Daarna start PLuMS met lege gegevens.",
      confirmLabel: "Apart zetten en nieuw beginnen",
      danger: true,
    });
    if (!ok) return;
    try {
      const keptAt = await controller.startFresh();
      setMessage(`Oude gegevens bewaard als: ${keptAt}`);
    } catch (error) {
      setMessage(`Apart zetten mislukt: ${(error as Error).message}`);
    }
  };

  return (
    <div className="center-screen">
      <div className="load-error" role="alert">
        <h1>Gegevens konden niet worden geladen</h1>
        <p>{load?.message}</p>
        {snapshot.storage && (
          <p className="muted">
            {snapshot.storage.type}: <code>{snapshot.storage.location}</code>
          </p>
        )}
        <p className="muted">
          PLuMS overschrijft deze gegevens niet. Je kunt het opnieuw proberen
          {load?.problem === "invalid" ? ", het bestand handmatig herstellen" : ""} of de gegevens apart zetten en
          nieuw beginnen.
        </p>
        {message && <p>{message}</p>}
        <div className="dialog-actions">
          <button className="button" onClick={() => void controller.load()}>
            Opnieuw proberen
          </button>
          {load?.problem === "invalid" && (
            <button className="button danger" onClick={() => void startFresh()}>
              Apart zetten en nieuw beginnen
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
