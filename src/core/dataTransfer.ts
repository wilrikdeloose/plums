import type { Platform } from "./platform";
import { serializeAppData, validateAppData, type AppData } from "./schema";

export type ImportCheck =
  | { ok: true; data: AppData; notes: string[]; summary: string }
  | { ok: false; error: string };

export function exportFileName(now = new Date()): string {
  const stamp = now.toISOString().slice(0, 10);
  return `plums-export-${stamp}.json`;
}

export async function exportData(platform: Platform, data: AppData): Promise<boolean> {
  return platform.files.saveJson(exportFileName(), serializeAppData(data));
}

/** Parses and validates an import file without touching current data. */
export function checkImport(platform: Platform, text: string): ImportCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return { ok: false, error: "Het bestand is geen geldige JSON." };
  }
  const result = validateAppData(
    raw,
    platform.capabilities.builtInMcp,
    platform.capabilities.canvasTestStudent === true,
  );
  if (!result.ok) return result;
  const d = result.data;
  const summary = `${d.conversations.length} gesprek(ken), ${d.ownTasks.length} eigen taak/taken, ${d.plans.length} planning(en)`;
  return { ok: true, data: d, notes: result.notes, summary };
}
