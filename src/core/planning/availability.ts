import type { Profile, Weekday } from "../schema";
import {
  addAmsterdamDays,
  amsterdamHhmm,
  amsterdamWeekday,
  amsterdamYmd,
  compareYmd,
  hhmmFromMinutes,
  minutesFromHhmm,
  mondayOfAmsterdamWeek,
} from "./time";

export interface TimeInterval {
  startMin: number;
  endMin: number;
}

export interface BusyBlock {
  date: string;
  start: string;
  end: string;
  title: string;
}

export interface DateExceptionInput {
  date: string;
  unavailable?: boolean;
  windowStart?: string | null;
  windowEnd?: string | null;
}

export interface FreeSlot {
  date: string;
  startMin: number;
  endMin: number;
}

function subtract(intervals: TimeInterval[], block: TimeInterval): TimeInterval[] {
  const out: TimeInterval[] = [];
  for (const iv of intervals) {
    if (block.endMin <= iv.startMin || block.startMin >= iv.endMin) {
      out.push(iv);
      continue;
    }
    if (block.startMin > iv.startMin) out.push({ startMin: iv.startMin, endMin: block.startMin });
    if (block.endMin < iv.endMin) out.push({ startMin: block.endMin, endMin: iv.endMin });
  }
  return out.filter((iv) => iv.endMin - iv.startMin >= 1);
}

function windowForDay(
  profile: Profile,
  weekday: Weekday,
): TimeInterval | null {
  const win = profile.dayWindows[weekday];
  if (!win) return null;
  const startMin = minutesFromHhmm(win.start);
  const endMin = minutesFromHhmm(win.end);
  if (endMin <= startMin) return null;
  // Cap by declared study hours when windows are longer than available hours.
  const hours = profile.availableStudyHours[weekday];
  const maxEnd = startMin + Math.round(hours * 60);
  return { startMin, endMin: Math.min(endMin, maxEnd) };
}

/**
 * Builds free study slots for a day or week horizon starting at `startDate`,
 * clipped so that on "today" only time after `now` is usable.
 */
export function buildFreeSlots(args: {
  profile: Profile;
  scope: "dag" | "week";
  startDate: string;
  now: Date;
  exceptions?: readonly DateExceptionInput[];
  /** One-off plan constraints: dates marked unavailable for this plan only. */
  oneOffUnavailableDates?: readonly string[];
  busy?: readonly BusyBlock[];
}): FreeSlot[] {
  const todayYmd = amsterdamYmd(args.now);
  const nowMin = minutesFromHhmm(amsterdamHhmm(args.now));
  const exceptionByDate = new Map((args.exceptions ?? []).map((e) => [e.date, e]));
  const oneOff = new Set(args.oneOffUnavailableDates ?? []);

  let dates: string[];
  if (args.scope === "dag") {
    dates = [args.startDate];
  } else {
    const monday = mondayOfAmsterdamWeek(args.startDate);
    dates = Array.from({ length: 7 }, (_, i) => addAmsterdamDays(monday, i));
  }

  const slots: FreeSlot[] = [];
  for (const date of dates) {
    if (compareYmd(date, todayYmd) < 0) continue;
    if (oneOff.has(date)) continue;

    const weekday = amsterdamWeekday(date);
    const ex = exceptionByDate.get(date);
    let base: TimeInterval | null;
    if (ex?.unavailable) {
      base = null;
    } else if (ex?.windowStart && ex?.windowEnd) {
      const s = minutesFromHhmm(ex.windowStart);
      const e = minutesFromHhmm(ex.windowEnd);
      base = e > s ? { startMin: s, endMin: e } : null;
    } else {
      base = windowForDay(args.profile, weekday);
    }
    if (!base) continue;

    let intervals: TimeInterval[] = [base];
    if (date === todayYmd) {
      intervals = subtract(intervals, { startMin: 0, endMin: nowMin });
    }

    for (const c of args.profile.fixedCommitments) {
      if (c.day !== weekday) continue;
      const s = minutesFromHhmm(c.start);
      const e = minutesFromHhmm(c.end);
      if (e > s) intervals = subtract(intervals, { startMin: s, endMin: e });
    }

    for (const b of args.busy ?? []) {
      if (b.date !== date) continue;
      const s = minutesFromHhmm(b.start);
      const e = minutesFromHhmm(b.end);
      if (e > s) intervals = subtract(intervals, { startMin: s, endMin: e });
    }

    for (const iv of intervals) {
      if (iv.endMin - iv.startMin >= 15) {
        slots.push({ date, startMin: iv.startMin, endMin: iv.endMin });
      }
    }
  }
  return slots;
}

export function describeSlot(slot: FreeSlot): string {
  return `${slot.date} ${hhmmFromMinutes(slot.startMin)}–${hhmmFromMinutes(slot.endMin)}`;
}
