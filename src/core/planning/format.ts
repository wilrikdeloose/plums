import type { Plan } from "../schema";
import { formatDutchLongDate } from "./time";

const PRIORITY_NL = { hoog: "Hoog", middel: "Middel", laag: "Laag" } as const;
const ORIGIN_NL = {
  canvas: "Canvas (feit)",
  student: "Student (invoer)",
  "ai-schatting": "AI-schatting",
} as const;

/** Renders a validated plan as Dutch Markdown for chat (not used as application state). */
export function formatPlanMarkdown(plan: Plan): string {
  const lines: string[] = [];
  const statusLabel = plan.status === "partial" ? "Planning (nog niet alles erin)" : "Planning";
  lines.push(`### ${statusLabel}: ${plan.title}`);
  lines.push(
    `**${plan.scope === "dag" ? "Dag" : "Week"}** vanaf ${formatDutchLongDate(plan.startDate)} · versie ${plan.revision}`,
  );
  if (plan.status === "partial") {
    lines.push(
      `> **Nog niet alles erin:** ${plan.capacityShortfallMinutes} minuten passen er niet bij zonder uren of deadlines te verschuiven.`,
    );
  }

  lines.push("");
  lines.push("| Datum | Start | Eind | Taak | Prioriteit | Deadline | Bron |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const b of plan.blocks) {
    const due = b.dueAt ? b.dueAt.slice(0, 16).replace("T", " ") : "—";
    const origin = b.isBreak ? "pauze" : ORIGIN_NL[b.origin];
    const title = b.estimateIsAi ? `${b.title} _(AI-schatting)_` : b.title;
    lines.push(
      `| ${b.date} | ${b.start} | ${b.end} | ${title} | ${PRIORITY_NL[b.priority]} | ${due} | ${origin}${b.sourceRef ? ` · \`${b.sourceRef}\`` : ""} |`,
    );
  }

  if (plan.unscheduled.length > 0) {
    lines.push("");
    lines.push("#### Nog niet ingepland");
    for (const u of plan.unscheduled) {
      lines.push(
        `- **${u.title}** (${u.remainingMinutes} min, ${PRIORITY_NL[u.priority]}): ${u.reason}`,
      );
    }
  }

  if (plan.assumptions.length > 0) {
    lines.push("");
    lines.push("#### Waar ik van uitging");
    for (const a of plan.assumptions) lines.push(`- ${a}`);
  }

  if (plan.warnings.length > 0) {
    lines.push("");
    lines.push("#### Let op");
    for (const w of plan.warnings) lines.push(`- ${w}`);
  }

  if (plan.oneOffConstraints.length > 0) {
    lines.push("");
    lines.push("#### Alleen voor deze planning");
    for (const c of plan.oneOffConstraints) {
      lines.push(`- ${c.note}${c.date ? ` (${c.date})` : ""}`);
    }
  }

  return lines.join("\n");
}
