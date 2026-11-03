import { newId } from "../conversations";
import type { Profile } from "../schema";
import {
  type BusyBlock,
  buildFreeSlots,
  type DateExceptionInput,
  type FreeSlot,
} from "./availability";
import { amsterdamYmd, compareYmd, hhmmFromMinutes, minutesFromHhmm } from "./time";

export type PlanPriority = "hoog" | "middel" | "laag";
export type PlanOrigin = "canvas" | "student" | "ai-schatting";

export interface ProposedTask {
  id: string;
  title: string;
  remainingMinutes: number;
  priority: PlanPriority;
  dueAt: string | null;
  origin: PlanOrigin;
  sourceRef: string | null;
  /** When true, remainingMinutes is an AI estimate that must be labeled. */
  estimateIsAi?: boolean;
  done?: boolean;
}

export interface AllocatedBlock {
  id: string;
  date: string;
  start: string;
  end: string;
  title: string;
  priority: PlanPriority;
  origin: PlanOrigin;
  sourceRef: string | null;
  taskId: string | null;
  dueAt: string | null;
  isBreak: boolean;
  estimateIsAi: boolean;
}

export interface UnscheduledItem {
  id: string;
  title: string;
  remainingMinutes: number;
  reason: string;
  priority: PlanPriority;
  dueAt: string | null;
  origin: PlanOrigin;
  sourceRef: string | null;
}

export interface AllocationResult {
  blocks: AllocatedBlock[];
  unscheduled: UnscheduledItem[];
  capacityShortfallMinutes: number;
  status: "complete" | "partial";
  warnings: string[];
}

const PRIORITY_ORDER: Record<PlanPriority, number> = { hoog: 0, middel: 1, laag: 2 };

function dueSortKey(dueAt: string | null): string {
  return dueAt ?? "9999-12-31T23:59:59Z";
}

function civilDateOfDue(dueAt: string | null): string | null {
  if (!dueAt) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(dueAt);
  return m ? m[1] : null;
}

function sortTasks(tasks: ProposedTask[]): ProposedTask[] {
  return [...tasks].sort((a, b) => {
    const po = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (po !== 0) return po;
    return dueSortKey(a.dueAt).localeCompare(dueSortKey(b.dueAt));
  });
}

/**
 * Packs proposed work into free slots with preferred block length and breaks.
 * Never extends hours, moves deadlines, or invents undated due dates.
 * Overdue / undated work is scheduled when capacity exists, or listed unscheduled.
 */
export function allocatePlan(args: {
  profile: Profile;
  scope: "dag" | "week";
  startDate: string;
  now: Date;
  tasks: ProposedTask[];
  busy?: BusyBlock[];
  exceptions?: DateExceptionInput[];
  oneOffUnavailableDates?: string[];
  includeCompleted?: boolean;
}): AllocationResult {
  const warnings: string[] = [];
  const preferred = args.profile.preferredBlockMinutes;
  const breakMin = args.profile.breakMinutes;

  const openTasks = args.tasks.filter((t) => {
    if (t.done && !args.includeCompleted) return false;
    if (t.remainingMinutes <= 0) return false;
    return true;
  });

  for (const t of openTasks) {
    if (t.remainingMinutes <= 0) {
      warnings.push(`Taak "${t.title}" heeft geen positieve resterende tijd.`);
    }
    const dueDay = civilDateOfDue(t.dueAt);
    if (dueDay && compareYmd(dueDay, amsterdamYmd(args.now)) < 0) {
      warnings.push(`Taak "${t.title}" heeft een verstreken deadline (${dueDay}); niet vooruitgeschoven.`);
    }
    if (!t.dueAt) {
      warnings.push(`Taak "${t.title}" heeft geen geverifieerde deadline.`);
    }
  }

  const slots = buildFreeSlots({
    profile: args.profile,
    scope: args.scope,
    startDate: args.startDate,
    now: args.now,
    exceptions: args.exceptions,
    oneOffUnavailableDates: args.oneOffUnavailableDates,
    busy: args.busy,
  });

  // Working copy of slots (mutable remaining capacity).
  const remainingSlots: FreeSlot[] = slots.map((s) => ({ ...s }));
  const blocks: AllocatedBlock[] = [];
  const unscheduled: UnscheduledItem[] = [];
  let shortfall = 0;

  const remainingByTask = new Map(openTasks.map((t) => [t.id, t.remainingMinutes]));

  for (const task of sortTasks(openTasks)) {
    let left = remainingByTask.get(task.id) ?? 0;
    const dueDay = civilDateOfDue(task.dueAt);

    while (left > 0) {
      const slotIdx = remainingSlots.findIndex((s) => {
        if (s.endMin - s.startMin < 15) return false;
        if (dueDay && compareYmd(s.date, dueDay) > 0) return false;
        return true;
      });
      if (slotIdx < 0) break;

      const slot = remainingSlots[slotIdx];
      const avail = slot.endMin - slot.startMin;
      const chunk = Math.min(left, preferred, avail);
      if (chunk < 15 && left >= 15 && avail < 15) {
        // Slot too small for meaningful work — drop it.
        remainingSlots.splice(slotIdx, 1);
        continue;
      }
      const use = Math.max(chunk, Math.min(left, avail));
      if (use < 1) {
        remainingSlots.splice(slotIdx, 1);
        continue;
      }

      const startMin = slot.startMin;
      const endMin = startMin + use;
      blocks.push({
        id: newId(),
        date: slot.date,
        start: hhmmFromMinutes(startMin),
        end: hhmmFromMinutes(endMin),
        title: task.title,
        priority: task.priority,
        origin: task.origin,
        sourceRef: task.sourceRef,
        taskId: task.id,
        dueAt: task.dueAt,
        isBreak: false,
        estimateIsAi: Boolean(task.estimateIsAi),
      });
      left -= use;
      remainingByTask.set(task.id, left);

      let cursor = endMin;
      // Insert break if more work remains in this slot after preferred chunk.
      if (left > 0 && breakMin > 0 && cursor + breakMin < slot.endMin) {
        const breakEnd = Math.min(cursor + breakMin, slot.endMin);
        if (breakEnd > cursor) {
          blocks.push({
            id: newId(),
            date: slot.date,
            start: hhmmFromMinutes(cursor),
            end: hhmmFromMinutes(breakEnd),
            title: "Pauze",
            priority: "laag",
            origin: "ai-schatting",
            sourceRef: null,
            taskId: null,
            dueAt: null,
            isBreak: true,
            estimateIsAi: false,
          });
          cursor = breakEnd;
        }
      }

      if (cursor >= slot.endMin) remainingSlots.splice(slotIdx, 1);
      else remainingSlots[slotIdx] = { ...slot, startMin: cursor };
    }

    if (left > 0) {
      shortfall += left;
      const reason =
        dueDay && remainingSlots.every((s) => compareYmd(s.date, dueDay) > 0 || s.endMin - s.startMin < 15)
          ? `Te weinig tijd vóór de deadline (${dueDay}).`
          : "Te weinig studietijd in deze periode.";
      unscheduled.push({
        id: task.id,
        title: task.title,
        remainingMinutes: left,
        reason,
        priority: task.priority,
        dueAt: task.dueAt,
        origin: task.origin,
        sourceRef: task.sourceRef,
      });
    }
  }

  // Remove trailing orphan breaks with no following work same day.
  const cleaned = blocks.filter((b, i) => {
    if (!b.isBreak) return true;
    const next = blocks.slice(i + 1).find((x) => x.date === b.date && !x.isBreak);
    return Boolean(next);
  });

  cleaned.sort((a, b) => a.date.localeCompare(b.date) || minutesFromHhmm(a.start) - minutesFromHhmm(b.start));

  return {
    blocks: cleaned,
    unscheduled,
    capacityShortfallMinutes: shortfall,
    status: unscheduled.length === 0 ? "complete" : "partial",
    warnings,
  };
}
