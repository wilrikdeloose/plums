import { WEEKDAYS, type Weekday } from "../schema";

export const PLAN_TIMEZONE = "Europe/Amsterdam";

const weekdayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: PLAN_TIMEZONE,
  weekday: "short",
});
const ymdFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: PLAN_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const hmFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: PLAN_TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const US_WEEKDAY_TO_NL: Record<string, Weekday> = {
  Mon: "ma",
  Tue: "di",
  Wed: "wo",
  Thu: "do",
  Fri: "vr",
  Sat: "za",
  Sun: "zo",
};

export function minutesFromHhmm(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function hhmmFromMinutes(total: number): string {
  const t = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(t / 60);
  const m = t % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Civil YYYY-MM-DD in Europe/Amsterdam for an instant. */
export function amsterdamYmd(instant: Date): string {
  return ymdFmt.format(instant);
}

/** HH:MM in Europe/Amsterdam for an instant. */
export function amsterdamHhmm(instant: Date): string {
  return hmFmt.format(instant).replace(/^24:/, "00:");
}

export function amsterdamWeekday(ymd: string): Weekday {
  const instant = amsterdamCivilToUtcInstant(ymd, "12:00");
  const key = weekdayFmt.format(instant);
  const day = US_WEEKDAY_TO_NL[key];
  if (!day) throw new Error(`Onbekende weekdag voor ${ymd}`);
  return day;
}

/**
 * Interprets a civil Amsterdam date+time as a UTC instant via iterative offset match
 * (DST-safe; does not add 24h blindly).
 */
export function amsterdamCivilToUtcInstant(ymd: string, hhmm: string): Date {
  const [y, mo, d] = ymd.split("-").map(Number);
  const minutes = minutesFromHhmm(hhmm);
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  // First guess: treat as UTC, then correct by Amsterdam offset.
  let guess = Date.UTC(y, mo - 1, d, hh, mm, 0);
  for (let i = 0; i < 3; i++) {
    const asDate = new Date(guess);
    const gotYmd = amsterdamYmd(asDate);
    const gotHm = amsterdamHhmm(asDate);
    if (gotYmd === ymd && gotHm === hhmmFromMinutes(minutes)) return asDate;
    const [gy, gmo, gd] = gotYmd.split("-").map(Number);
    const gotMin = minutesFromHhmm(gotHm);
    const wantCivil = Date.UTC(y, mo - 1, d, hh, mm);
    const gotCivil = Date.UTC(gy, gmo - 1, gd, Math.floor(gotMin / 60), gotMin % 60);
    guess += wantCivil - gotCivil;
  }
  return new Date(guess);
}

/** Add whole civil days in Amsterdam (DST-safe). */
export function addAmsterdamDays(ymd: string, deltaDays: number): string {
  const noon = amsterdamCivilToUtcInstant(ymd, "12:00");
  const next = new Date(noon.getTime() + deltaDays * 24 * 60 * 60 * 1000);
  // Re-anchor at noon to absorb DST transitions when stepping.
  return amsterdamYmd(new Date(amsterdamCivilToUtcInstant(amsterdamYmd(next), "12:00").getTime()));
}

/** Monday (week start) of the Amsterdam week containing `ymd`. */
export function mondayOfAmsterdamWeek(ymd: string): string {
  const day = amsterdamWeekday(ymd);
  const idx = WEEKDAYS.indexOf(day);
  return addAmsterdamDays(ymd, -idx);
}

export function compareYmd(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isValidYmd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const parts = s.split("-").map(Number);
  const m = parts[1];
  const d = parts[2];
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const rebuilt = amsterdamYmd(amsterdamCivilToUtcInstant(s, "12:00"));
  return rebuilt === s;
}

export function formatDutchLongDate(ymd: string): string {
  const instant = amsterdamCivilToUtcInstant(ymd, "12:00");
  return new Intl.DateTimeFormat("nl-NL", {
    timeZone: PLAN_TIMEZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(instant);
}
