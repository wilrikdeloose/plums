import type { Plan, PlanBlock, Profile } from "../schema";
import { buildFreeSlots, type BusyBlock, type DateExceptionInput } from "./availability";
import { amsterdamWeekday, compareYmd, isValidYmd, minutesFromHhmm } from "./time";

export interface PlanValidationIssue {
  code: string;
  message: string;
}

/**
 * Deterministic checks on an allocated/saved plan: IDs, durations, overlaps,
 * availability, commitments, and before-deadline feasibility for scheduled work.
 */
export function validateAllocatedPlan(args: {
  plan: Pick<Plan, "scope" | "startDate" | "blocks" | "unscheduled" | "status" | "oneOffConstraints">;
  profile: Profile;
  now: Date;
  busy?: BusyBlock[];
  exceptions?: DateExceptionInput[];
}): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];
  const { plan, profile } = args;

  if (!isValidYmd(plan.startDate)) {
    issues.push({ code: "startDate", message: "Ongeldige startdatum." });
  }
  if (plan.scope !== "dag" && plan.scope !== "week") {
    issues.push({ code: "scope", message: "Scope moet dag of week zijn." });
  }

  const ids = new Set<string>();
  for (const b of plan.blocks) {
    if (ids.has(b.id)) issues.push({ code: "id", message: `Dubbel blok-ID: ${b.id}` });
    ids.add(b.id);
    if (!isValidYmd(b.date)) {
      issues.push({ code: "date", message: `Ongeldige blokdatum: ${b.date}` });
      continue;
    }
    const start = minutesFromHhmm(b.start);
    const end = minutesFromHhmm(b.end);
    if (end <= start) {
      issues.push({ code: "duration", message: `Blok "${b.title}" heeft geen positieve duur.` });
    }
  }

  // Overlaps (same date, non-break and break both count as occupying time).
  const byDate = new Map<string, PlanBlock[]>();
  for (const b of plan.blocks) {
    const list = byDate.get(b.date) ?? [];
    list.push(b);
    byDate.set(b.date, list);
  }
  for (const [date, list] of byDate) {
    const sorted = [...list].sort((a, b) => minutesFromHhmm(a.start) - minutesFromHhmm(b.start));
    for (let i = 1; i < sorted.length; i++) {
      if (minutesFromHhmm(sorted[i].start) < minutesFromHhmm(sorted[i - 1].end)) {
        issues.push({
          code: "overlap",
          message: `Overlappende blokken op ${date}: "${sorted[i - 1].title}" en "${sorted[i].title}".`,
        });
      }
    }
  }

  const oneOff = (plan.oneOffConstraints ?? [])
    .filter((c) => c.type === "date_unavailable" && c.date)
    .map((c) => c.date!);

  const free = buildFreeSlots({
    profile,
    scope: plan.scope,
    startDate: plan.startDate,
    now: args.now,
    exceptions: args.exceptions ?? profile.dateExceptions,
    oneOffUnavailableDates: oneOff,
    busy: args.busy,
  });

  for (const b of plan.blocks) {
    if (b.isBreak) continue;
    const start = minutesFromHhmm(b.start);
    const end = minutesFromHhmm(b.end);
    const ok = free.some((s) => s.date === b.date && start >= s.startMin && end <= s.endMin);
    if (!ok) {
      // Also accept if entirely inside union of free slots after merge — simple check above is enough for PoC.
      const weekday = amsterdamWeekday(b.date);
      const commitmentHit = profile.fixedCommitments.some(
        (c) =>
          c.day === weekday &&
          minutesFromHhmm(c.start) < end &&
          minutesFromHhmm(c.end) > start,
      );
      if (commitmentHit) {
        issues.push({
          code: "commitment",
          message: `Blok "${b.title}" valt in een vaste verplichting.`,
        });
      } else {
        issues.push({
          code: "availability",
          message: `Blok "${b.title}" valt buiten beschikbare studietijd.`,
        });
      }
    }

    if (b.dueAt) {
      const dueDay = b.dueAt.slice(0, 10);
      if (isValidYmd(dueDay) && compareYmd(b.date, dueDay) > 0) {
        issues.push({
          code: "deadline",
          message: `Blok "${b.title}" is gepland na de geverifieerde deadline (${dueDay}).`,
        });
      }
    }
  }

  if (plan.status === "complete" && (plan.unscheduled?.length ?? 0) > 0) {
    issues.push({
      code: "status",
      message: "Een complete planning mag geen niet-ingeplande taken bevatten.",
    });
  }

  return issues;
}
