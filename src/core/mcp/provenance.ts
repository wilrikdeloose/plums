import type { AppData, CanvasCategory, CanvasProvenance, CanvasSourceRef } from "../schema";
import { normalizeCanvasBaseUrl, normalizeRemoteMcpUrl } from "./url";

export interface ActiveCanvasScope {
  /** Stable connection/account scope identifier (`builtin:<canvasUrl>:v<ver>` or `remote:<mcpUrl>:v<ver>`). */
  scopeId: string;
  mode: "builtin" | "remote";
  endpointUrl: string | null;
  selectedCourseIds: ReadonlySet<string>;
  enabledCategories: Readonly<Record<CanvasCategory, boolean>>;
  /** Courses whose Canvas Test Student data may be used; always empty outside agreeing test builds. */
  testStudentCourseIds: ReadonlySet<string>;
}

/**
 * Courses for which the Canvas Test Student is effectively active: requires an agreeing test build,
 * the built-in server and a selected course. Remote MCP servers have no reviewed equivalent.
 */
export function effectiveTestStudentCourseIds(
  data: AppData,
  supportsBuiltinMcp: boolean,
  canvasTestStudent: boolean,
): string[] {
  if (!canvasTestStudent || !supportsBuiltinMcp || data.settings.mcp.mode !== "builtin") return [];
  const selected = new Set(data.settings.canvas.selectedCourseIds);
  return data.settings.canvas.testStudentCourseIds.filter((id) => selected.has(id));
}

/**
 * Computes the current connection/account + permission scope.
 * `credentialEpoch` increments whenever a Canvas or MCP credential is saved, replaced, or removed,
 * ensuring any account/credential change invalidates prior provenance.
 */
export function getActiveCanvasScope(
  data: AppData,
  supportsBuiltinMcp: boolean,
  credentialEpoch = 0,
  canvasTestStudent = false,
): ActiveCanvasScope {
  const mode = supportsBuiltinMcp ? data.settings.mcp.mode : "remote";
  let endpointUrl: string | null = null;
  if (mode === "builtin") {
    const norm = normalizeCanvasBaseUrl(data.settings.canvas.baseUrl);
    if (norm.ok) endpointUrl = norm.url;
  } else {
    const norm = normalizeRemoteMcpUrl(data.settings.mcp.remoteUrl);
    if (norm.ok) endpointUrl = norm.url;
  }

  const scopeId = `${mode}:${endpointUrl ?? "unconfigured"}:v${credentialEpoch}`;
  return {
    scopeId,
    mode,
    endpointUrl,
    selectedCourseIds: new Set(data.settings.canvas.selectedCourseIds),
    enabledCategories: { ...data.settings.canvas.categories },
    testStudentCourseIds: new Set(effectiveTestStudentCourseIds(data, supportsBuiltinMcp, canvasTestStudent)),
  };
}

/**
 * Checks whether a historical message's or cached tool result's `CanvasProvenance`
 * is still permitted under the current connection/account scope, selected courses, and enabled categories.
 */
export function isProvenanceAllowed(
  provenance: CanvasProvenance | undefined,
  scope: ActiveCanvasScope,
): boolean {
  if (!provenance) return true;
  if (provenance.scopeId !== scope.scopeId) return false;
  for (const cat of provenance.categories) {
    if (!scope.enabledCategories[cat]) return false;
  }
  for (const courseId of provenance.courseIds) {
    if (!scope.selectedCourseIds.has(courseId)) return false;
  }
  for (const courseId of provenance.testStudentCourseIds ?? []) {
    if (!scope.testStudentCourseIds.has(courseId)) return false;
  }
  return true;
}

/**
 * Plans derived from Canvas/Test Student data are only usable while provenance still matches
 * the current scope. Permanent profile is unaffected by one-off plan constraints.
 */
export function isPlanAllowed(plan: AppData["plans"][number], scope: ActiveCanvasScope): boolean {
  if (!(plan.testStudentCourseIds ?? []).every((id) => scope.testStudentCourseIds.has(id))) {
    return false;
  }
  if (plan.canvasProvenance) {
    return isProvenanceAllowed(plan.canvasProvenance, scope);
  }
  return true;
}

/**
 * Filters a message's stored `CanvasSourceRef[]` so only sources that remain permitted
 * under the current scope are used for context or reference resolution.
 */
export function filterAllowedSources(
  sources: readonly CanvasSourceRef[] | undefined,
  scope: ActiveCanvasScope,
): CanvasSourceRef[] {
  if (!sources || sources.length === 0) return [];
  return sources.filter(
    (s) =>
      scope.enabledCategories[s.category] &&
      scope.selectedCourseIds.has(s.courseId) &&
      (!s.testStudent || scope.testStudentCourseIds.has(s.courseId)),
  );
}
