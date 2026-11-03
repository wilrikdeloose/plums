import { useEffect, useRef, useState, type ReactNode } from "react";
import { testConnection } from "../core/ai/client";
import { chatCompletionsUrl } from "../core/ai/endpoint";
import { newId } from "../core/conversations";
import { checkImport, exportData } from "../core/dataTransfer";
import {
  canvasSecretKey,
  normalizeCanvasBaseUrl,
  normalizeRemoteMcpUrl,
  remoteMcpSecretKey,
} from "../core/mcp/url";
import { CANVAS_CATEGORIES, WEEKDAYS, type AppData, type CanvasCategory, type Weekday } from "../core/schema";
import { useConfirm } from "./Confirm";
import { useCanvasSnapshot, useServices, useSnapshot } from "./context";
import { IconClose, IconTrash } from "./icons";
import { SaveStatus } from "./SaveStatus";
import { TEST_BUILD } from "./testBuild";
import { TestStudentSettings } from "./TestStudentSettings";

const TABS = [
  ["profiel", "Profiel"],
  ["taken", "Eigen taken"],
  ["personalisatie", "Personalisatie"],
  ["ai", "AI"],
  ["canvas", "Canvas"],
  ["mcp", "MCP"],
  ["gegevens", "Gegevens"],
] as const;
type Tab = (typeof TABS)[number][0];

const DAY_NAMES: Record<Weekday, string> = {
  ma: "Maandag",
  di: "Dinsdag",
  wo: "Woensdag",
  do: "Donderdag",
  vr: "Vrijdag",
  za: "Zaterdag",
  zo: "Zondag",
};

const CATEGORY_NAMES: Record<CanvasCategory, string> = {
  assignments: "Opdrachten en deadlines",
  submissions: "Eigen inleverstatus",
  announcements: "Announcements",
  calendar: "Agenda-items",
  modules: "Modules en pagina's",
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("profiel");
  const { data } = useSnapshot();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".confirm-overlay")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!data) return null;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog settings" role="dialog" aria-modal="true" aria-label="Profiel en instellingen">
        <header className="settings-header">
          <h2>Profiel en instellingen</h2>
          <button className="icon-button" onClick={onClose} aria-label="Sluiten" title="Sluiten">
            <IconClose />
          </button>
        </header>
        <div className="settings-body">
          <nav className="tabs" role="tablist">
            {TABS.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "tab active" : "tab"} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </nav>
          <section className="tab-panel" role="tabpanel">
            {tab === "profiel" && <ProfileTab data={data} />}
            {tab === "taken" && <OwnTasksTab data={data} />}
            {tab === "personalisatie" && <PersonalizationTab data={data} />}
            {tab === "ai" && <AiTab data={data} />}
            {tab === "canvas" && <CanvasTab data={data} />}
            {tab === "mcp" && <McpTab data={data} />}
            {tab === "gegevens" && <DataTab data={data} />}
          </section>
        </div>
        <footer className="settings-footer">
          <SaveStatus />
          <span className="muted small">Wijzigingen worden automatisch opgeslagen.</span>
        </footer>
      </div>
    </div>
  );
}

function useUpdate() {
  const { controller } = useServices();
  return (mutate: (d: AppData) => void) => controller.update(mutate);
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

function Unavailable({ children }: { children: ReactNode }) {
  return <p className="unavailable">{children}</p>;
}

/** Keeps the typed text locally and only commits valid numbers. */
function NumberInput(props: { value: number; min: number; max: number; step: number; integer?: boolean; label: string; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => setText(String(props.value)), [props.value]);
  const parsed = Number(text.replace(",", "."));
  const valid = text.trim() !== "" && Number.isFinite(parsed) && parsed >= props.min && parsed <= props.max && (!props.integer || Number.isInteger(parsed));
  return (
    <input
      type="number"
      aria-label={props.label}
      aria-invalid={!valid}
      min={props.min}
      max={props.max}
      step={props.step}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value.replace(",", "."));
        if (e.target.value.trim() !== "" && Number.isFinite(n) && n >= props.min && n <= props.max && (!props.integer || Number.isInteger(n))) {
          props.onCommit(n);
        }
      }}
      onBlur={() => !valid && setText(String(props.value))}
    />
  );
}

function ProfileTab({ data }: { data: AppData }) {
  const update = useUpdate();
  const p = data.profile;
  const totalHours = WEEKDAYS.reduce((sum, d) => sum + p.availableStudyHours[d], 0);

  return (
    <>
      <Field label="Naam">
        <input value={p.name} onChange={(e) => update((d) => void (d.profile.name = e.target.value))} placeholder="Je voornaam" />
      </Field>
      <Field label="Studiecontext" hint="Bijvoorbeeld opleiding, semester, profiel of project.">
        <textarea rows={3} value={p.studyContext} onChange={(e) => update((d) => void (d.profile.studyContext = e.target.value))} placeholder="HBO-ICT, semester 3, Software" />
      </Field>

      <h3>Beschikbare studie-uren per dag</h3>
      <div className="hours-grid">
        {WEEKDAYS.map((day) => (
          <label key={day} className="hours-cell">
            <span>{DAY_NAMES[day]}</span>
            <NumberInput
              label={`Studie-uren ${DAY_NAMES[day]}`}
              value={p.availableStudyHours[day]}
              min={0}
              max={24}
              step={0.5}
              onCommit={(n) =>
                update((d) => {
                  d.profile.availableStudyHours[day] = n;
                  if (n <= 0) d.profile.dayWindows[day] = null;
                  else if (!d.profile.dayWindows[day]) {
                    const endMin = 9 * 60 + Math.round(n * 60);
                    d.profile.dayWindows[day] = {
                      start: "09:00",
                      end: `${String(Math.min(23, Math.floor(endMin / 60))).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`,
                    };
                  }
                })
              }
            />
          </label>
        ))}
      </div>
      <p className="muted small">Totaal: {totalHours.toLocaleString("nl-NL")} uur per week (max binnen die tijden).</p>

      <h3>Wanneer studeer je?</h3>
      <p className="muted small">Op welke tijden je meestal wilt studeren (Europe/Amsterdam). Uit = die dag niet.</p>
      <div className="commitments">
        {WEEKDAYS.map((day) => {
          const win = p.dayWindows[day];
          return (
            <div key={day} className="commitment">
              <span style={{ minWidth: "5.5rem" }}>{DAY_NAMES[day]}</span>
              <input
                type="time"
                aria-label={`Begin ${DAY_NAMES[day]}`}
                disabled={!win}
                value={win?.start ?? "09:00"}
                onChange={(e) =>
                  TIME.test(e.target.value) &&
                  update((d) => {
                    const cur = d.profile.dayWindows[day] ?? { start: "09:00", end: "17:00" };
                    d.profile.dayWindows[day] = { ...cur, start: e.target.value };
                  })
                }
              />
              <span>–</span>
              <input
                type="time"
                aria-label={`Einde ${DAY_NAMES[day]}`}
                disabled={!win}
                value={win?.end ?? "17:00"}
                onChange={(e) =>
                  TIME.test(e.target.value) &&
                  update((d) => {
                    const cur = d.profile.dayWindows[day] ?? { start: "09:00", end: "17:00" };
                    d.profile.dayWindows[day] = { ...cur, end: e.target.value };
                  })
                }
              />
              <label className="check">
                <input
                  type="checkbox"
                  checked={Boolean(win)}
                  onChange={(e) =>
                    update((d) => {
                      if (e.target.checked) {
                        d.profile.dayWindows[day] = { start: "09:00", end: "17:00" };
                        if (d.profile.availableStudyHours[day] <= 0) d.profile.availableStudyHours[day] = 6;
                      } else {
                        d.profile.dayWindows[day] = null;
                      }
                    })
                  }
                />
                Actief
              </label>
            </div>
          );
        })}
      </div>

      <h3>Dagen die even anders zijn</h3>
      <p className="muted small">Bijv. een vrije dag of andere tijden. Als je in de chat zegt &ldquo;woensdag kan ik niet&rdquo;, verandert dit hier niet automatisch.</p>
      {p.dateExceptions.length === 0 && <p className="muted small">Nog geen uitzonderingen.</p>}
      <div className="commitments">
        {p.dateExceptions.map((ex, index) => {
          const set = (mutate: (target: AppData["profile"]["dateExceptions"][number]) => void) =>
            update((d) => {
              const target = d.profile.dateExceptions.find((x) => x.id === ex.id);
              if (target) mutate(target);
            });
          return (
            <div key={ex.id} className="commitment">
              <input
                type="date"
                aria-label={`Uitzonderingsdatum ${index + 1}`}
                value={ex.date}
                onChange={(e) => set((t) => void (t.date = e.target.value))}
              />
              <label className="check">
                <input
                  type="checkbox"
                  checked={Boolean(ex.unavailable)}
                  onChange={(e) => set((t) => void (t.unavailable = e.target.checked))}
                />
                Hele dag weg
              </label>
              {!ex.unavailable && (
                <>
                  <input
                    type="time"
                    aria-label={`Begin uitzondering ${index + 1}`}
                    value={ex.windowStart ?? "09:00"}
                    onChange={(e) => TIME.test(e.target.value) && set((t) => void (t.windowStart = e.target.value))}
                  />
                  <span>–</span>
                  <input
                    type="time"
                    aria-label={`Einde uitzondering ${index + 1}`}
                    value={ex.windowEnd ?? "17:00"}
                    onChange={(e) => TIME.test(e.target.value) && set((t) => void (t.windowEnd = e.target.value))}
                  />
                </>
              )}
              <input
                aria-label={`Notitie uitzondering ${index + 1}`}
                placeholder="Notitie"
                value={ex.note ?? ""}
                onChange={(e) => set((t) => void (t.note = e.target.value))}
              />
              <button
                className="icon-button"
                aria-label={`Uitzondering ${index + 1} verwijderen`}
                title="Verwijderen"
                onClick={() =>
                  update((d) => void (d.profile.dateExceptions = d.profile.dateExceptions.filter((x) => x.id !== ex.id)))
                }
              >
                <IconTrash />
              </button>
            </div>
          );
        })}
      </div>
      <button
        className="button"
        onClick={() =>
          update((d) =>
            void d.profile.dateExceptions.push({
              id: newId(),
              date: new Date().toISOString().slice(0, 10),
              unavailable: true,
              note: "",
            }),
          )
        }
      >
        Uitzondering toevoegen
      </button>

      <h3>Vaste verplichtingen</h3>
      {p.fixedCommitments.length === 0 && <p className="muted small">Nog geen vaste verplichtingen (zoals werk, sport of lessen).</p>}
      <div className="commitments">
        {p.fixedCommitments.map((c, index) => {
          const set = (mutate: (target: AppData["profile"]["fixedCommitments"][number]) => void) =>
            update((d) => {
              const target = d.profile.fixedCommitments.find((x) => x.id === c.id);
              if (target) mutate(target);
            });
          return (
            <div key={c.id} className="commitment">
              <select aria-label={`Dag verplichting ${index + 1}`} value={c.day} onChange={(e) => set((t) => void (t.day = e.target.value as Weekday))}>
                {WEEKDAYS.map((day) => (
                  <option key={day} value={day}>
                    {DAY_NAMES[day]}
                  </option>
                ))}
              </select>
              <input type="time" aria-label={`Begintijd verplichting ${index + 1}`} value={c.start} onChange={(e) => TIME.test(e.target.value) && set((t) => void (t.start = e.target.value))} />
              <span>–</span>
              <input type="time" aria-label={`Eindtijd verplichting ${index + 1}`} value={c.end} onChange={(e) => TIME.test(e.target.value) && set((t) => void (t.end = e.target.value))} />
              <input aria-label={`Omschrijving verplichting ${index + 1}`} placeholder="Omschrijving" value={c.description} onChange={(e) => set((t) => void (t.description = e.target.value))} />
              <button
                className="icon-button"
                aria-label={`Verplichting ${index + 1} verwijderen`}
                title="Verwijderen"
                onClick={() => update((d) => void (d.profile.fixedCommitments = d.profile.fixedCommitments.filter((x) => x.id !== c.id)))}
              >
                <IconTrash />
              </button>
              {c.end <= c.start && <span className="field-error">Eindtijd moet na de begintijd liggen.</span>}
            </div>
          );
        })}
      </div>
      <button
        className="button"
        onClick={() => update((d) => void d.profile.fixedCommitments.push({ id: newId(), day: "ma", start: "09:00", end: "10:00", description: "" }))}
      >
        Verplichting toevoegen
      </button>

      <h3>Werkblokken</h3>
      <Field label="Voorkeurslengte van een werkblok (minuten)" hint="Tussen 15 en 240 minuten.">
        <NumberInput
          label="Voorkeurslengte werkblok"
          value={p.preferredBlockMinutes}
          min={15}
          max={240}
          step={5}
          integer
          onCommit={(n) => update((d) => void (d.profile.preferredBlockMinutes = n))}
        />
      </Field>
      <Field label="Pauze tussen werkblokken (minuten)" hint="0–60 minuten.">
        <NumberInput
          label="Pauze tussen blokken"
          value={p.breakMinutes}
          min={0}
          max={60}
          step={5}
          integer
          onCommit={(n) => update((d) => void (d.profile.breakMinutes = n))}
        />
      </Field>
    </>
  );
}

function OwnTasksTab({ data }: { data: AppData }) {
  const update = useUpdate();
  const tasks = data.ownTasks;

  return (
    <>
      <p className="muted small">
        Wat speelt er nog meer? Denk aan een bijbaan-klus, een tentamen waar je voor wilt leren of iets wat je jezelf hebt
        voorgenomen. PLuMS houdt hier rekening mee als jullie samen plannen en als je om advies vraagt. Vink iets af als
        het klaar is, dan wordt het niet meer ingepland.
      </p>
      {tasks.length === 0 && <p className="muted small">Je hebt nog niets toegevoegd.</p>}
      <div className="commitments">
        {tasks.map((t, index) => {
          const set = (mutate: (target: AppData["ownTasks"][number]) => void) =>
            update((d) => {
              const target = d.ownTasks.find((x) => x.id === t.id);
              if (target) mutate(target);
            });
          return (
            <div key={t.id} className="commitment" style={{ flexWrap: "wrap" }}>
              <input
                aria-label={`Titel taak ${index + 1}`}
                placeholder="Titel"
                value={t.title}
                onChange={(e) => set((x) => void (x.title = e.target.value))}
                style={{ minWidth: "12rem", flex: 1 }}
              />
              <NumberInput
                label={`Resterende minuten taak ${index + 1}`}
                value={t.estimateMinutes ?? 0}
                min={0}
                max={24 * 60}
                step={15}
                integer
                onCommit={(n) => set((x) => void (x.estimateMinutes = n === 0 ? null : n))}
              />
              <input
                type="datetime-local"
                aria-label={`Deadline taak ${index + 1}`}
                value={t.dueAt ? t.dueAt.slice(0, 16) : ""}
                onChange={(e) =>
                  set((x) => void (x.dueAt = e.target.value ? new Date(e.target.value).toISOString() : null))
                }
              />
              <select
                aria-label={`Prioriteit taak ${index + 1}`}
                value={t.priority}
                onChange={(e) => set((x) => void (x.priority = e.target.value as "hoog" | "middel" | "laag"))}
              >
                <option value="hoog">Hoog</option>
                <option value="middel">Middel</option>
                <option value="laag">Laag</option>
              </select>
              <label className="check">
                <input type="checkbox" checked={t.done} onChange={(e) => set((x) => void (x.done = e.target.checked))} />
                Klaar
              </label>
              <button
                className="icon-button"
                aria-label={`Taak ${index + 1} verwijderen`}
                title="Verwijderen"
                onClick={() => update((d) => void (d.ownTasks = d.ownTasks.filter((x) => x.id !== t.id)))}
              >
                <IconTrash />
              </button>
            </div>
          );
        })}
      </div>
      <button
        className="button"
        onClick={() =>
          update((d) =>
            void d.ownTasks.push({
              id: newId(),
              title: "",
              notes: "",
              dueAt: null,
              estimateMinutes: 60,
              priority: "middel",
              done: false,
              createdAt: new Date().toISOString(),
            }),
          )
        }
      >
        Taak toevoegen
      </button>
    </>
  );
}

function PersonalizationTab({ data }: { data: AppData }) {
  const update = useUpdate();
  return (
    <Field label="Aanvullende systeeminstructies" hint="Deze instructies worden vanaf stap 4 meegegeven aan de AI, naast de vaste PLuMS-instructies.">
      <textarea
        rows={10}
        value={data.settings.personalization.systemInstructions}
        onChange={(e) => update((d) => void (d.settings.personalization.systemInstructions = e.target.value))}
        placeholder="Bijvoorbeeld: Antwoord kort en geef altijd eerst de belangrijkste deadline."
      />
    </Field>
  );
}

type KeyState = { endpoint: string; status: "checking" | "stored" | "missing" | "error"; message?: string };
type TestState = { signature: string; status: "testing" | "ok" | "failed"; message: string };

function AiTab({ data }: { data: AppData }) {
  const update = useUpdate();
  const { platform } = useServices();
  const ai = data.settings.ai;
  const endpoint = chatCompletionsUrl(ai.baseUrl);
  const endpointUrl = endpoint.ok ? endpoint.url : "";
  const [keyInput, setKeyInput] = useState("");
  const [keyVersion, setKeyVersion] = useState(0);
  const [keyState, setKeyState] = useState<KeyState | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMessage, setKeyMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [test, setTest] = useState<TestState | null>(null);
  const testAbort = useRef<AbortController | null>(null);
  const signature = `${endpointUrl}|${ai.model.trim()}|${keyVersion}`;
  const session = platform.secrets.persistence === "session";

  useEffect(() => {
    if (!endpointUrl) {
      setKeyState(null);
      return;
    }
    let current = true;
    setKeyState({ endpoint: endpointUrl, status: "checking" });
    platform.secrets.has(endpointUrl).then(
      (stored) => current && setKeyState({ endpoint: endpointUrl, status: stored ? "stored" : "missing" }),
      (error: Error) => current && setKeyState({ endpoint: endpointUrl, status: "error", message: error.message }),
    );
    return () => {
      current = false;
    };
  }, [platform, endpointUrl, keyVersion]);

  useEffect(() => {
    testAbort.current?.abort();
  }, [signature]);

  useEffect(() => {
    setKeyMessage(null);
    setKeyInput("");
  }, [endpointUrl]);

  useEffect(() => () => testAbort.current?.abort(), []);

  const saveKey = async () => {
    if (!endpointUrl) return;
    setKeyBusy(true);
    setKeyMessage(null);
    try {
      await platform.secrets.save(endpointUrl, keyInput);
      setKeyInput("");
      setKeyVersion((v) => v + 1);
      setKeyMessage({ kind: "ok", text: session ? "Sleutel bewaard voor deze browsersessie." : "Sleutel beveiligd opgeslagen." });
    } catch (error) {
      setKeyMessage({ kind: "error", text: (error as Error).message });
    } finally {
      setKeyBusy(false);
    }
  };

  const removeKey = async () => {
    if (!endpointUrl) return;
    setKeyBusy(true);
    setKeyMessage(null);
    try {
      await platform.secrets.remove(endpointUrl);
      setKeyVersion((v) => v + 1);
      setKeyMessage({ kind: "ok", text: "Sleutel verwijderd voor dit endpoint." });
    } catch (error) {
      setKeyMessage({ kind: "error", text: (error as Error).message });
    } finally {
      setKeyBusy(false);
    }
  };

  const runTest = async () => {
    if (!endpointUrl || !ai.model.trim()) return;
    testAbort.current?.abort();
    const abort = new AbortController();
    testAbort.current = abort;
    const sig = signature;
    setTest({ signature: sig, status: "testing", message: "Testverzoek wordt verstuurd…" });
    try {
      const reply = await testConnection(platform.http, endpointUrl, ai.model.trim(), abort.signal);
      setTest({ signature: sig, status: "ok", message: `Verbinding werkt: het model gaf een geldig antwoord${reply ? ` ("${reply}")` : ""}.` });
    } catch (error) {
      if (abort.signal.aborted) return;
      setTest({ signature: sig, status: "failed", message: (error as Error).message });
    }
  };

  const keyStored = keyState?.endpoint === endpointUrl && keyState.status === "stored";
  const currentTest = test?.signature === signature ? test : null;

  return (
    <>
      <Field
        label="Basis-URL (OpenAI-compatibel)"
        hint={
          ai.baseUrl && !endpoint.ok ? (
            <span className="field-error">{endpoint.error}</span>
          ) : endpoint.ok ? (
            <>
              Verzoeken gaan naar <code>{endpoint.url}</code>
            </>
          ) : (
            "Bijvoorbeeld https://api.openai.com/v1"
          )
        }
      >
        <input value={ai.baseUrl} onChange={(e) => update((d) => void (d.settings.ai.baseUrl = e.target.value.trim()))} placeholder="https://…/v1" spellCheck={false} />
      </Field>
      <Field label="Model" hint="De model-slug die PLuMS gebruikt; los van het model in Cursor.">
        <input value={ai.model} onChange={(e) => update((d) => void (d.settings.ai.model = e.target.value.trim()))} placeholder="bijv. gpt-4o-mini" spellCheck={false} />
      </Field>

      <h3>API-sleutel</h3>
      <p className="muted small">
        {session
          ? "In de browser wordt de sleutel alleen in het geheugen van deze pagina bewaard. Na herladen moet je hem opnieuw invoeren."
          : "De sleutel wordt beveiligd opgeslagen door het besturingssysteem (Windows Credential Manager of macOS-sleutelhanger), nooit in your.data."}{" "}
        De sleutel hoort bij precies dit endpoint en wordt niet meegestuurd naar een ander endpoint.
      </p>
      {!endpoint.ok ? (
        <p className="unavailable">Vul eerst een geldige basis-URL in.</p>
      ) : (
        <>
          <p className={keyStored ? "key-status ok" : "key-status"} role="status">
            {keyState?.status === "checking" && "Status controleren…"}
            {keyState?.status === "stored" && (session ? "Sleutel aanwezig voor deze sessie." : "Sleutel opgeslagen voor dit endpoint.")}
            {keyState?.status === "missing" && "Geen sleutel voor dit endpoint."}
            {keyState?.status === "error" && <span className="error">{keyState.message}</span>}
          </p>
          <form
            className="key-row"
            onSubmit={(e) => {
              e.preventDefault();
              void saveKey();
            }}
          >
            <input
              type="password"
              aria-label="API-sleutel"
              autoComplete="off"
              spellCheck={false}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={keyStored ? "Nieuwe sleutel om te vervangen" : "Plak je API-sleutel"}
            />
            <button type="submit" className="button" disabled={keyBusy || !keyInput.trim()}>
              {keyStored ? "Sleutel vervangen" : "Sleutel opslaan"}
            </button>
            <button type="button" className="button danger" disabled={keyBusy || !keyStored} onClick={() => void removeKey()}>
              Sleutel verwijderen
            </button>
          </form>
          {keyMessage && <p className={`status-message ${keyMessage.kind}`}>{keyMessage.text}</p>}
        </>
      )}

      <h3>Verbinding</h3>
      <button className="button" disabled={!endpoint.ok || !ai.model.trim() || !keyStored || currentTest?.status === "testing"} onClick={() => void runTest()}>
        {currentTest?.status === "testing" ? "Testen…" : "Verbinding testen"}
      </button>
      <p className="muted small">Stuurt een klein, echt chatverzoek met dit model. Dit kan een fractie van een cent kosten.</p>
      {currentTest && currentTest.status !== "testing" && (
        <p className={`status-message ${currentTest.status === "ok" ? "ok" : "error"}`} role="status">
          {currentTest.message}
        </p>
      )}
    </>
  );
}

function CanvasTab({ data }: { data: AppData }) {
  const update = useUpdate();
  const { platform, canvas: canvasService } = useServices();
  const canvasSnap = useCanvasSnapshot();
  const canvas = data.settings.canvas;
  const builtin = platform.capabilities.builtInMcp && data.settings.mcp.mode === "builtin";
  const normBase = normalizeCanvasBaseUrl(canvas.baseUrl);
  const secretKey = normBase.ok ? canvasSecretKey(normBase.url) : "";
  const session = platform.secrets.persistence === "session";

  const [tokenInput, setTokenInput] = useState("");
  const [tokenVersion, setTokenVersion] = useState(0);
  const [tokenState, setTokenState] = useState<KeyState | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenMessage, setTokenMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!builtin || !secretKey) {
      setTokenState(null);
      return;
    }
    let current = true;
    setTokenState({ endpoint: secretKey, status: "checking" });
    platform.secrets.has(secretKey).then(
      (stored) => current && setTokenState({ endpoint: secretKey, status: stored ? "stored" : "missing" }),
      (error: Error) => current && setTokenState({ endpoint: secretKey, status: "error", message: error.message }),
    );
    return () => {
      current = false;
    };
  }, [platform, builtin, secretKey, tokenVersion]);

  useEffect(() => {
    setTokenMessage(null);
    setTokenInput("");
  }, [secretKey]);

  const saveToken = async () => {
    if (!secretKey) return;
    setTokenBusy(true);
    setTokenMessage(null);
    try {
      await platform.secrets.save(secretKey, tokenInput);
      setTokenInput("");
      setTokenVersion((v) => v + 1);
      await canvasService.notifyCredentialChanged();
      setTokenMessage({
        kind: "ok",
        text: session
          ? "Canvas-token bewaard voor deze browsersessie."
          : "Canvas-token beveiligd opgeslagen in het besturingssysteem.",
      });
    } catch (error) {
      setTokenMessage({ kind: "error", text: (error as Error).message });
    } finally {
      setTokenBusy(false);
    }
  };

  const removeToken = async () => {
    if (!secretKey) return;
    setTokenBusy(true);
    setTokenMessage(null);
    try {
      await platform.secrets.remove(secretKey);
      setTokenVersion((v) => v + 1);
      await canvasService.notifyCredentialChanged();
      setTokenMessage({ kind: "ok", text: "Canvas-token verwijderd voor deze Canvas-URL." });
    } catch (error) {
      setTokenMessage({ kind: "error", text: (error as Error).message });
    } finally {
      setTokenBusy(false);
    }
  };

  const tokenStored = tokenState?.endpoint === secretKey && tokenState.status === "stored";
  const remoteNorm = normalizeRemoteMcpUrl(data.settings.mcp.remoteUrl);
  const canLoadCourses = builtin ? normBase.ok && tokenStored : remoteNorm.ok;
  const testing = canvasSnap.status === "connecting";

  const toggleCourse = (courseId: string, checked: boolean) => {
    update((d) => {
      const current = new Set(d.settings.canvas.selectedCourseIds);
      if (checked) current.add(courseId);
      else current.delete(courseId);
      d.settings.canvas.selectedCourseIds = [...current];
    });
  };

  const availableIds = new Set(canvasSnap.availableCourses.map((c) => c.id));
  const extraSelectedIds = canvas.selectedCourseIds.filter((id) => !availableIds.has(id));

  return (
    <>
      {builtin ? (
        <>
          <Field
            label="Canvas basis-URL"
            hint={
              canvas.baseUrl && !normBase.ok ? (
                <span className="field-error">{normBase.error}</span>
              ) : normBase.ok ? (
                <>
                  Alleen-lezen verzoeken gaan uitsluitend naar <code>{normBase.url}/api/v1/…</code>
                </>
              ) : (
                "Bijvoorbeeld https://fhict.instructure.com"
              )
            }
          >
            <input
              value={canvas.baseUrl}
              onChange={(e) => update((d) => void (d.settings.canvas.baseUrl = e.target.value.trim()))}
              placeholder="https://fhict.instructure.com"
              spellCheck={false}
            />
          </Field>

          <h3>Persoonlijk Canvas-toegangstoken</h3>
          <p className="muted small">
            Alleen gebruiken met een eigen testaccount waarvan je eigenaar bent. Het token wordt beveiligd opgeslagen in het besturingssysteem (nooit in <code>your.data</code> of exports) en uitsluitend naar dit Canvas-domein gestuurd.
          </p>
          {!normBase.ok ? (
            <Unavailable>Vul eerst een geldige Canvas basis-URL in.</Unavailable>
          ) : (
            <>
              <p className={tokenStored ? "key-status ok" : "key-status"} role="status">
                {tokenState?.status === "checking" && "Tokenstatus controleren…"}
                {tokenState?.status === "stored" && "Canvas-token opgeslagen voor dit Canvas-domein."}
                {tokenState?.status === "missing" && "Geen Canvas-token opgeslagen voor dit Canvas-domein."}
                {tokenState?.status === "error" && <span className="error">{tokenState.message}</span>}
              </p>
              <form
                className="key-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveToken();
                }}
              >
                <input
                  type="password"
                  aria-label="Canvas-token"
                  autoComplete="off"
                  spellCheck={false}
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder={tokenStored ? "Nieuw token om te vervangen" : "Plak je Canvas-toegangstoken"}
                />
                <button type="submit" className="button" disabled={tokenBusy || !tokenInput.trim()}>
                  {tokenStored ? "Token vervangen" : "Token opslaan"}
                </button>
                <button
                  type="button"
                  className="button danger"
                  disabled={tokenBusy || !tokenStored}
                  onClick={() => void removeToken()}
                >
                  Token verwijderen
                </button>
              </form>
              {tokenMessage && <p className={`status-message ${tokenMessage.kind}`}>{tokenMessage.text}</p>}
            </>
          )}
        </>
      ) : (
        <Unavailable>
          In de externe MCP-modus leest de externe MCP-server Canvas. De Canvas-URL en het Canvas-token worden op die server beheerd; PLuMS stuurt een lokaal Canvas-token <strong>nooit</strong> door naar een externe MCP-URL.
        </Unavailable>
      )}

      <h3>Cursussen en verbinding</h3>
      <div className="button-row">
        <button
          className="button"
          disabled={!canLoadCourses || testing}
          onClick={() => void canvasService.testConnectionAndLoadCourses()}
        >
          {testing ? "Verbinden en cursussen ophalen…" : "Verbinding testen & cursussen ophalen"}
        </button>
      </div>
      <ConnectionStatusBox />

      {canvasSnap.availableCourses.length > 0 ? (
        <>
          <div className="button-row">
            <button
              type="button"
              className="button small"
              onClick={() =>
                update((d) => {
                  d.settings.canvas.selectedCourseIds = canvasSnap.availableCourses.map((c) => c.id);
                })
              }
            >
              Alles selecteren
            </button>
            <button
              type="button"
              className="button small"
              onClick={() =>
                update((d) => {
                  d.settings.canvas.selectedCourseIds = [];
                })
              }
            >
              Selectie wissen
            </button>
          </div>
          <div className="checks">
            {canvasSnap.availableCourses.map((course) => {
              const checked = canvas.selectedCourseIds.includes(course.id);
              return (
                <label key={course.id} className="check">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => toggleCourse(course.id, e.target.checked)}
                  />
                  <span>
                    <strong>{course.name}</strong>
                    {course.courseCode ? ` (${course.courseCode})` : ""} · <span className="muted small">ID {course.id}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </>
      ) : (
        <p className="muted small">
          Klik op &ldquo;Verbinding testen &amp; cursussen ophalen&rdquo; om je actieve Canvas-cursussen via MCP te laden. Alleen aangevinkte cursussen mogen worden gelezen.
        </p>
      )}

      {extraSelectedIds.length > 0 && (
        <div className="checks">
          <span className="field-hint">Eerder geselecteerde cursus-ID&apos;s (nog niet geladen in deze sessie):</span>
          {extraSelectedIds.map((id) => (
            <label key={id} className="check">
              <input type="checkbox" checked onChange={(e) => toggleCourse(id, e.target.checked)} />
              <span>Cursus-ID {id}</span>
            </label>
          ))}
        </div>
      )}

      <h3>Leescategorieën</h3>
      <p className="muted small">
        Uitgeschakelde categorieën worden direct geblokkeerd: lopende leesacties ervoor worden afgebroken en eerder geladen gegevens worden gewist. Canvas is strikt alleen-lezen.
      </p>
      <div className="checks">
        {CANVAS_CATEGORIES.map((cat) => (
          <label key={cat} className="check">
            <input
              type="checkbox"
              checked={canvas.categories[cat]}
              onChange={(e) => update((d) => void (d.settings.canvas.categories[cat] = e.target.checked))}
            />
            {CATEGORY_NAMES[cat]}
          </label>
        ))}
      </div>

      {TEST_BUILD && <TestStudentSettings data={data} courses={canvasSnap.availableCourses} update={update} />}
    </>
  );
}

function ConnectionStatusBox() {
  const snap = useCanvasSnapshot();
  if (snap.status === "idle") return null;

  return (
    <div
      className={`status-message ${snap.status === "verified" ? "ok" : snap.status === "error" ? "error" : ""}`}
      role="status"
    >
      {snap.status === "connecting" && <p>MCP-verbinding en Canvas-toegang worden gecontroleerd…</p>}
      {snap.mcpConnected && (
        <p>
          <strong>MCP-verbinding:</strong> Verbonden met <code>{snap.serverName}</code>
          {snap.serverVersion ? ` v${snap.serverVersion}` : ""} (protocol <code>{snap.protocolVersion}</code>).
        </p>
      )}
      {snap.canvasAccessVerified && (
        <p>
          <strong>Canvas-toegang:</strong> Geverifieerd ({snap.availableCourses.length} actieve cursus(sen) gelezen).
        </p>
      )}
      {snap.errorMessage && <p>{snap.errorMessage}</p>}
      {snap.warnings.map((w) => (
        <p key={w} className="small">
          Let op: {w}
        </p>
      ))}
    </div>
  );
}

function McpTab({ data }: { data: AppData }) {
  const update = useUpdate();
  const { platform, canvas: canvasService } = useServices();
  const canvasSnap = useCanvasSnapshot();
  const mcp = data.settings.mcp;
  const effectiveMode = platform.capabilities.builtInMcp ? mcp.mode : "remote";
  const remoteNorm = normalizeRemoteMcpUrl(mcp.remoteUrl);
  const secretKey = remoteNorm.ok ? remoteMcpSecretKey(remoteNorm.url) : "";
  const session = platform.secrets.persistence === "session";

  const [tokenInput, setTokenInput] = useState("");
  const [tokenVersion, setTokenVersion] = useState(0);
  const [tokenState, setTokenState] = useState<KeyState | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenMessage, setTokenMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (effectiveMode !== "remote" || !secretKey) {
      setTokenState(null);
      return;
    }
    let current = true;
    setTokenState({ endpoint: secretKey, status: "checking" });
    platform.secrets.has(secretKey).then(
      (stored) => current && setTokenState({ endpoint: secretKey, status: stored ? "stored" : "missing" }),
      (error: Error) => current && setTokenState({ endpoint: secretKey, status: "error", message: error.message }),
    );
    return () => {
      current = false;
    };
  }, [platform, effectiveMode, secretKey, tokenVersion]);

  useEffect(() => {
    setTokenMessage(null);
    setTokenInput("");
  }, [secretKey]);

  const saveMcpToken = async () => {
    if (!secretKey) return;
    setTokenBusy(true);
    setTokenMessage(null);
    try {
      await platform.secrets.save(secretKey, tokenInput);
      setTokenInput("");
      setTokenVersion((v) => v + 1);
      await canvasService.notifyCredentialChanged();
      setTokenMessage({
        kind: "ok",
        text: session
          ? "MCP Bearer-token bewaard voor deze browsersessie."
          : "MCP Bearer-token beveiligd opgeslagen voor deze MCP-URL.",
      });
    } catch (error) {
      setTokenMessage({ kind: "error", text: (error as Error).message });
    } finally {
      setTokenBusy(false);
    }
  };

  const removeMcpToken = async () => {
    if (!secretKey) return;
    setTokenBusy(true);
    setTokenMessage(null);
    try {
      await platform.secrets.remove(secretKey);
      setTokenVersion((v) => v + 1);
      await canvasService.notifyCredentialChanged();
      setTokenMessage({ kind: "ok", text: "MCP Bearer-token verwijderd voor dit endpoint." });
    } catch (error) {
      setTokenMessage({ kind: "error", text: (error as Error).message });
    } finally {
      setTokenBusy(false);
    }
  };

  const tokenStored = tokenState?.endpoint === secretKey && tokenState.status === "stored";
  const canvasNorm = normalizeCanvasBaseUrl(data.settings.canvas.baseUrl);
  const canTest = effectiveMode === "builtin" ? canvasNorm.ok : remoteNorm.ok;
  const testing = canvasSnap.status === "connecting";

  return (
    <>
      {platform.capabilities.builtInMcp ? (
        <fieldset className="radio-group">
          <legend>Canvas MCP-server</legend>
          <label className="check">
            <input
              type="radio"
              name="mcp-mode"
              checked={mcp.mode === "builtin"}
              onChange={() => update((d) => void (d.settings.mcp.mode = "builtin"))}
            />
            Ingebouwd (onderdeel van deze desktop-app)
          </label>
          <label className="check">
            <input
              type="radio"
              name="mcp-mode"
              checked={mcp.mode === "remote"}
              onChange={() => update((d) => void (d.settings.mcp.mode = "remote"))}
            />
            Extern (Streamable HTTP-URL)
          </label>
        </fieldset>
      ) : (
        <p className="muted">
          De browser ondersteunt uitsluitend een externe MCP-server via Streamable HTTP. De ingebouwde Canvas MCP-server is alleen onderdeel van de desktop-app.
        </p>
      )}

      {effectiveMode === "remote" ? (
        <>
          <Field
            label="Externe MCP-URL"
            hint={
              mcp.remoteUrl && !remoteNorm.ok ? (
                <span className="field-error">{remoteNorm.error}</span>
              ) : remoteNorm.ok ? (
                <>
                  Streamable HTTP-endpoint: <code>{remoteNorm.url}</code>
                </>
              ) : (
                "Bijvoorbeeld https://mcp.example.com/mcp"
              )
            }
          >
            <input
              value={mcp.remoteUrl}
              onChange={(e) => update((d) => void (d.settings.mcp.remoteUrl = e.target.value.trim()))}
              placeholder="https://…/mcp"
              spellCheck={false}
            />
          </Field>

          <h3>Externe MCP-authenticatie (optioneel Bearer-token)</h3>
          <p className="muted small">
            Dit optionele Bearer-token staat volledig los van je Canvas-token en hoort alleen bij deze externe MCP-URL. Interactieve OAuth/DPoP-flows worden niet ondersteund; als de server dat vereist, meldt PLuMS dit bij het testen.
          </p>
          {!remoteNorm.ok ? (
            <Unavailable>Vul eerst een geldige externe MCP-URL in.</Unavailable>
          ) : (
            <>
              <p className={tokenStored ? "key-status ok" : "key-status"} role="status">
                {tokenState?.status === "checking" && "Status controleren…"}
                {tokenState?.status === "stored" &&
                  (session
                    ? "Optioneel MCP Bearer-token aanwezig voor deze browsersessie."
                    : "Optioneel MCP Bearer-token opgeslagen voor deze MCP-URL.")}
                {tokenState?.status === "missing" &&
                  "Geen MCP Bearer-token ingesteld (verbinding zonder Authorization-header)."}
                {tokenState?.status === "error" && <span className="error">{tokenState.message}</span>}
              </p>
              <form
                className="key-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveMcpToken();
                }}
              >
                <input
                  type="password"
                  aria-label="MCP Bearer-token"
                  autoComplete="off"
                  spellCheck={false}
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder={tokenStored ? "Nieuw MCP-token om te vervangen" : "Optioneel MCP Bearer-token"}
                />
                <button type="submit" className="button" disabled={tokenBusy || !tokenInput.trim()}>
                  {tokenStored ? "Token vervangen" : "Token opslaan"}
                </button>
                <button
                  type="button"
                  className="button danger"
                  disabled={tokenBusy || !tokenStored}
                  onClick={() => void removeMcpToken()}
                >
                  Token verwijderen
                </button>
              </form>
              {tokenMessage && <p className={`status-message ${tokenMessage.kind}`}>{tokenMessage.text}</p>}
            </>
          )}
        </>
      ) : (
        <p className="muted small">
          De ingebouwde Canvas MCP-server draait in-process binnen de desktop-app en gebruikt de Canvas basis-URL en het Canvas-token uit het tabblad <strong>Canvas</strong>.
        </p>
      )}

      <h3>Verbinding en ondersteunde functies</h3>
      <div className="button-row">
        <button
          className="button"
          disabled={!canTest || testing}
          onClick={() => void canvasService.testConnectionAndLoadCourses()}
        >
          {testing ? "Testen…" : "Verbinding testen"}
        </button>
      </div>
      <ConnectionStatusBox />

      <div className="table-wrap">
        <table className="capability-table">
          <thead>
            <tr>
              <th>Canvas-leesfunctie</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {canvasSnap.operationStatuses.map((op) => (
              <tr key={op.operation}>
                <td>{op.label}</td>
                <td>
                  <span
                    className={
                      op.supportedByServer && op.enabledInSettings
                        ? "key-status ok"
                        : !op.supportedByServer && canvasSnap.capabilityMap
                          ? "error"
                          : "muted"
                    }
                  >
                    {op.statusText}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canvasSnap.capabilityMap && canvasSnap.capabilityMap.rejectedTools.length > 0 && (
        <div>
          <h4>Geblokkeerde of afgewezen server-tools</h4>
          <p className="muted small">
            PLuMS laat alleen gecontroleerde leesfuncties toe die cursus- en categoriegrenzen afdwingen. De volgende tools van de server zijn geblokkeerd:
          </p>
          <ul className="muted small">
            {canvasSnap.capabilityMap.rejectedTools.map((rt) => (
              <li key={rt.name}>
                <code>{rt.name}</code>: {rt.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function DataTab({ data }: { data: AppData }) {
  const { platform, controller, runner } = useServices();
  const { storage, notes } = useSnapshot();
  const confirm = useConfirm();
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setStatus(null);
    try {
      await task();
    } catch (error) {
      setStatus({ kind: "error", text: (error as Error).message ?? String(error) });
    } finally {
      setBusy(false);
    }
  };

  const doExport = () =>
    run(async () => {
      const saved = await exportData(platform, data);
      if (saved) setStatus({ kind: "ok", text: "Export opgeslagen. Geheimen worden nooit geëxporteerd." });
    });

  const doImport = () =>
    run(async () => {
      const text = await platform.files.openJson();
      if (text === null) return;
      const check = checkImport(platform, text);
      if (!check.ok) {
        setStatus({ kind: "error", text: `Import geweigerd: ${check.error} Je huidige gegevens zijn niet gewijzigd.` });
        return;
      }
      const ok = await confirm({
        title: "Huidige gegevens vervangen?",
        message: (
          <>
            <p>Het bestand is geldig en bevat {check.summary}.</p>
            <p>Al je huidige gesprekken, instellingen, taken en planningen worden vervangen.</p>
            {check.notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </>
        ),
        confirmLabel: "Vervangen",
        danger: true,
      });
      if (!ok) return;
      runner.cancelAll();
      await controller.replace(check.data);
      setStatus({ kind: "ok", text: ["Gegevens geïmporteerd.", ...check.notes].join(" ") });
    });

  const deleteConversations = () =>
    run(async () => {
      const ok = await confirm({
        title: "Alle gesprekken verwijderen?",
        message: `Alle ${data.conversations.length} gesprek(ken) worden definitief verwijderd. Instellingen en profiel blijven bewaard.`,
        confirmLabel: "Gesprekken verwijderen",
        danger: true,
      });
      if (!ok) return;
      runner.cancelAll();
      controller.update((d) => void (d.conversations = []));
      await controller.flush();
      setStatus({ kind: "ok", text: "Alle gesprekken zijn verwijderd." });
    });

  const deleteAll = () =>
    run(async () => {
      const ok = await confirm({
        title: "Alle lokale gegevens verwijderen?",
        message: "Gesprekken, profiel, instellingen, eigen taken en planningen worden definitief verwijderd van dit apparaat. Exporteer eerst als je een kopie wilt bewaren.",
        confirmLabel: "Alles verwijderen",
        danger: true,
      });
      if (!ok) return;
      runner.cancelAll();
      await controller.clearAll();
      setStatus({ kind: "ok", text: "Alle lokale gegevens zijn verwijderd." });
    });

  return (
    <>
      <h3>Opslag</h3>
      <dl className="storage-info">
        <dt>Type</dt>
        <dd>{storage?.type ?? "Onbekend"}</dd>
        <dt>Locatie</dt>
        <dd>
          <code>{storage?.location ?? "Onbekend"}</code>
        </dd>
        <dt>Inhoud</dt>
        <dd>
          {data.conversations.length} gesprek(ken), {data.ownTasks.length} eigen taak/taken, {data.plans.length} planning(en) · schemaversie {data.version}
        </dd>
      </dl>
      {notes.map((n) => (
        <p key={n} className="muted small">
          {n}
        </p>
      ))}

      <h3>Exporteren en importeren</h3>
      <p className="muted small">Export en import gebruiken hetzelfde JSON-formaat op desktop en in de browser. Sleutels en tokens worden nooit geëxporteerd.</p>
      <div className="button-row">
        <button className="button" disabled={busy} onClick={() => void doExport()}>
          Exporteren…
        </button>
        <button className="button" disabled={busy} onClick={() => void doImport()}>
          Importeren…
        </button>
      </div>

      <h3>Verwijderen</h3>
      <div className="button-row">
        <button className="button danger" disabled={busy || data.conversations.length === 0} onClick={() => void deleteConversations()}>
          Alle gesprekken verwijderen
        </button>
        <button className="button danger" disabled={busy} onClick={() => void deleteAll()}>
          Alle lokale gegevens verwijderen
        </button>
      </div>

      {status && (
        <p className={status.kind === "error" ? "status-message error" : "status-message ok"} role="status">
          {status.text}
        </p>
      )}
    </>
  );
}
