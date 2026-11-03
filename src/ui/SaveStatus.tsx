import { useServices, useSnapshot } from "./context";

export function SaveStatus() {
  const { save } = useSnapshot();
  const { controller } = useServices();
  switch (save.status) {
    case "idle":
      return null;
    case "pending":
    case "saving":
      return <p className="save-status muted small">Opslaan…</p>;
    case "saved":
      return <p className="save-status muted small">Opgeslagen om {save.at.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}</p>;
    case "failed":
      return (
        <div className="save-status error small" role="alert">
          <span>{save.message}</span>
          <button className="link-button" onClick={() => void controller.flush().catch(() => undefined)}>
            Opnieuw proberen
          </button>
        </div>
      );
  }
}
