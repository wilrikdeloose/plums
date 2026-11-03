import type { Plan } from "../core/schema";
import { formatDutchLongDate } from "../core/planning/time";

const PRIORITY_NL = { hoog: "Hoog", middel: "Middel", laag: "Laag" } as const;
const ORIGIN_NL = {
  canvas: "Canvas",
  student: "Student",
  "ai-schatting": "AI-schatting",
} as const;

export function PlanTable({ plan }: { plan: Plan }) {
  return (
    <div className="plan-table-wrap">
      <div className="plan-table-header">
        <strong>{plan.title}</strong>
        <span className="test-badge">
          {plan.status === "partial" ? "Nog niet alles erin" : "Rond"} · versie {plan.revision}
        </span>
        <span className="muted small">
          {plan.scope === "dag" ? "Dag" : "Week"} vanaf {formatDutchLongDate(plan.startDate)}
        </span>
      </div>
      {plan.status === "partial" && (
        <p className="unavailable">
          {plan.capacityShortfallMinutes} minuten passen er niet bij (zonder uren of deadlines te verschuiven).
        </p>
      )}
      <div className="plan-table-scroll">
        <table className="plan-table">
          <thead>
            <tr>
              <th>Datum</th>
              <th>Start</th>
              <th>Eind</th>
              <th>Taak</th>
              <th>Prio</th>
              <th>Deadline</th>
              <th>Bron</th>
            </tr>
          </thead>
          <tbody>
            {plan.blocks.map((b) => (
              <tr key={b.id} className={b.isBreak ? "plan-break" : undefined}>
                <td>{b.date}</td>
                <td>{b.start}</td>
                <td>{b.end}</td>
                <td>
                  {b.title}
                  {b.estimateIsAi ? <span className="muted small"> · AI-schatting</span> : null}
                </td>
                <td>{PRIORITY_NL[b.priority]}</td>
                <td>{b.dueAt ? b.dueAt.slice(0, 16).replace("T", " ") : "—"}</td>
                <td>{b.isBreak ? "Pauze" : ORIGIN_NL[b.origin]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {plan.unscheduled.length > 0 && (
        <div className="plan-unscheduled">
          <strong>Nog niet ingepland</strong>
          <ul>
            {plan.unscheduled.map((u) => (
              <li key={u.id}>
                {u.title} ({u.remainingMinutes} min) — {u.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {plan.assumptions.length > 0 && (
        <details className="plan-meta">
          <summary>Waar ik van uitging ({plan.assumptions.length})</summary>
          <ul>
            {plan.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </details>
      )}
      {plan.warnings.length > 0 && (
        <details className="plan-meta">
          <summary>Let op ({plan.warnings.length})</summary>
          <ul>
            {plan.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      {plan.oneOffConstraints.length > 0 && (
        <details className="plan-meta">
          <summary>Alleen voor deze planning ({plan.oneOffConstraints.length})</summary>
          <ul>
            {plan.oneOffConstraints.map((c) => (
              <li key={c.id}>
                {c.note}
                {c.date ? ` (${c.date})` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
