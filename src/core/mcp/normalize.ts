import type { CanvasCategory } from "../schema";
import { htmlToPlainText } from "./html";
import {
  type CanvasCourse,
  type CanvasListResult,
  type CanvasSourceItem,
  CanvasMcpError,
} from "./types";
import { validateSameOriginUrl } from "./url";

function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function bool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  return undefined;
}

/** Preserves null/missing dates as null; normalizes valid date strings to ISO strings when possible. */
export function normalizeDateOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  return trimmed;
}

function extractCourseIdFromContext(contextCode: unknown): string | null {
  if (typeof contextCode !== "string") return null;
  const match = /^course_([A-Za-z0-9_-]+)$/i.exec(contextCode.trim());
  return match ? match[1] : null;
}

function sanitizeCanvasUrl(rawUrl: unknown, expectedOrigin?: string): string | null {
  const candidate = str(rawUrl);
  if (!candidate) return null;
  if (expectedOrigin) {
    return validateSameOriginUrl(candidate, expectedOrigin);
  }
  try {
    const u = new URL(candidate);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

interface RawEnvelope {
  items?: unknown;
  courses?: unknown;
  assignments?: unknown;
  submissions?: unknown;
  announcements?: unknown;
  events?: unknown;
  modules?: unknown;
  page?: unknown;
  truncated?: unknown;
  warnings?: unknown;
  retrievedAt?: unknown;
  retrieved_at?: unknown;
  enrollmentStatus?: unknown;
  enrollment_status?: unknown;
  enrollmentRoles?: unknown;
  enrollment_roles?: unknown;
}

function parseEnvelope(raw: unknown, nowIso: string): {
  list: unknown[];
  single: Record<string, unknown> | null;
  truncated: boolean;
  warnings: string[];
  retrievedAt: string;
  enrollmentStatus?: string;
  enrollmentRoles?: string[];
} {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new CanvasMcpError("protocol", "De MCP-server stuurde geen geldige JSON terug.");
    }
  }
  if (Array.isArray(obj)) {
    return { list: obj, single: null, truncated: false, warnings: [], retrievedAt: nowIso };
  }
  if (typeof obj !== "object" || obj === null) {
    throw new CanvasMcpError("protocol", "De MCP-server stuurde een ongeldig antwoordoject terug.");
  }
  const env = obj as RawEnvelope;
  const retrievedAt = normalizeDateOrNull(env.retrievedAt ?? env.retrieved_at) ?? nowIso;
  const truncated = env.truncated === true;
  const warnings = Array.isArray(env.warnings)
    ? env.warnings.filter((w): w is string => typeof w === "string" && w.trim().length > 0)
    : [];
  const enrollmentStatus = str(env.enrollmentStatus ?? env.enrollment_status) ?? undefined;
  const enrollmentRoles = Array.isArray(env.enrollmentRoles ?? env.enrollment_roles)
    ? ((env.enrollmentRoles ?? env.enrollment_roles) as unknown[]).filter((x): x is string => typeof x === "string")
    : undefined;

  const candidateList =
    env.items ?? env.courses ?? env.assignments ?? env.submissions ?? env.announcements ?? env.events ?? env.modules;
  if (Array.isArray(candidateList)) {
    return { list: candidateList, single: null, truncated, warnings, retrievedAt, enrollmentStatus, enrollmentRoles };
  }
  if (env.page && typeof env.page === "object" && !Array.isArray(env.page)) {
    return { list: [], single: env.page as Record<string, unknown>, truncated, warnings, retrievedAt, enrollmentStatus, enrollmentRoles };
  }
  return { list: [obj], single: obj as Record<string, unknown>, truncated, warnings, retrievedAt, enrollmentStatus, enrollmentRoles };
}

export function normalizeCoursesPayload(raw: unknown, expectedOrigin?: string, nowIso = new Date().toISOString()): CanvasListResult<CanvasCourse> {
  const { list, truncated, warnings, retrievedAt } = parseEnvelope(raw, nowIso);
  const items: CanvasCourse[] = [];

  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    const id = str(r.id);
    const name = str(r.name) ?? str(r.original_name) ?? str(r.course_code);
    if (!id || !name) continue;
    const workflowState = str(r.workflowState ?? r.workflow_state);
    if (workflowState === "deleted") continue;
    const fallbackUrl = expectedOrigin ? `${expectedOrigin}/courses/${encodeURIComponent(id)}` : null;
    items.push({
      id,
      name,
      courseCode: str(r.courseCode ?? r.course_code),
      workflowState,
      startAt: normalizeDateOrNull(r.startAt ?? r.start_at),
      endAt: normalizeDateOrNull(r.endAt ?? r.end_at),
      url: sanitizeCanvasUrl(r.url ?? r.html_url, expectedOrigin) ?? fallbackUrl,
      retrievedAt: normalizeDateOrNull(r.retrievedAt ?? r.retrieved_at) ?? retrievedAt,
    });
  }

  return { items, truncated, warnings, retrievedAt };
}

export function normalizeAssignmentsPayload(
  raw: unknown,
  allowedCourseId: string,
  courseNames: ReadonlyMap<string, string>,
  expectedOrigin?: string,
  nowIso = new Date().toISOString(),
): CanvasListResult<CanvasSourceItem> {
  const { list, truncated, warnings, retrievedAt } = parseEnvelope(raw, nowIso);
  const items: CanvasSourceItem[] = [];

  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    const rawId = str(r.id ?? r.assignmentId ?? r.assignment_id);
    if (!rawId) continue;
    const courseId = str(r.courseId ?? r.course_id) ?? allowedCourseId;
    if (courseId !== allowedCourseId) continue;
    // Drop explicitly unpublished drafts (e.g. teacher token); omit/keep when `published` is absent.
    if (r.published === false) continue;

    const title = str(r.title ?? r.name) ?? `Opdracht ${rawId}`;
    const rawHtml = str(r.text ?? r.description) ?? "";
    const text = htmlToPlainText(rawHtml);
    // Preserve missing due dates as null; use effective user-specific due_at
    const dueAt = normalizeDateOrNull(r.dueAt ?? r.due_at);
    const unlockAt = normalizeDateOrNull(r.startAt ?? r.unlock_at);
    const lockAt = normalizeDateOrNull(r.endAt ?? r.lock_at);
    const updatedAt = normalizeDateOrNull(r.updatedAt ?? r.updated_at);
    const fallbackUrl = expectedOrigin
      ? `${expectedOrigin}/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(rawId)}`
      : null;

    const subTypes = Array.isArray(r.submissionTypes ?? r.submission_types)
      ? ((r.submissionTypes ?? r.submission_types) as unknown[]).filter((x): x is string => typeof x === "string")
      : undefined;

    items.push({
      id: rawId.startsWith("canvas:") ? rawId : `canvas:assignment:${courseId}:${rawId}`,
      category: "assignments",
      courseId,
      courseName: str(r.courseName ?? r.course_name) ?? courseNames.get(courseId) ?? null,
      title,
      text,
      dueAt,
      startAt: unlockAt,
      endAt: lockAt,
      submittedAt: null,
      updatedAt,
      url: sanitizeCanvasUrl(r.url ?? r.html_url, expectedOrigin) ?? fallbackUrl,
      retrievedAt: normalizeDateOrNull(r.retrievedAt ?? r.retrieved_at) ?? retrievedAt,
      pointsPossible: num(r.pointsPossible ?? r.points_possible),
      submissionTypes: subTypes,
      workflowState: str(r.workflowState ?? r.workflow_state),
      assignmentId: rawId.replace(/^canvas:assignment:[^:]+:/, ""),
    });
  }

  return { items, truncated, warnings, retrievedAt };
}

export function normalizeSubmissionsPayload(
  raw: unknown,
  allowedCourseId: string,
  courseNames: ReadonlyMap<string, string>,
  expectedOrigin?: string,
  nowIso = new Date().toISOString(),
): CanvasListResult<CanvasSourceItem> {
  const { list, truncated, warnings, retrievedAt, enrollmentStatus, enrollmentRoles } = parseEnvelope(raw, nowIso);
  const items: CanvasSourceItem[] = [];

  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    const assignmentObj =
      typeof r.assignment === "object" && r.assignment !== null ? (r.assignment as Record<string, unknown>) : null;
    const nestedSubmission =
      typeof r.submission === "object" && r.submission !== null ? (r.submission as Record<string, unknown>) : null;
    // Join strictly by courseId and assignmentId; never infer own status from `has_submitted_submissions`.
    const assignmentId = str(
      r.assignmentId ??
        r.assignment_id ??
        assignmentObj?.id ??
        (nestedSubmission ? r.id : undefined),
    );
    if (!assignmentId) continue;
    const courseId = str(r.courseId ?? r.course_id ?? assignmentObj?.course_id) ?? allowedCourseId;
    if (courseId !== allowedCourseId) continue;

    const subSource = nestedSubmission ?? r;
    // Preserve missing/unknown workflow_state as "unknown" — NEVER default missing status to "unsubmitted"!
    const rawWorkflowState = str(subSource.workflowState ?? subSource.workflow_state);
    const workflowState = rawWorkflowState ?? "unknown";
    const submittedAt = normalizeDateOrNull(subSource.submittedAt ?? subSource.submitted_at);
    // Preserve Canvas workflow_state and submitted_at without equating `graded` with work completed when `submitted_at` is null!
    const submitted =
      bool(subSource.submitted) ??
      (workflowState === "unknown" || workflowState === "not_applicable"
        ? undefined
        : submittedAt !== null || workflowState === "submitted" || workflowState === "pending_review");
    const missing = bool(subSource.missing) ?? false;
    const late = bool(subSource.late) ?? false;
    const excused = bool(subSource.excused) ?? false;
    const score = num(subSource.score);
    const grade = str(subSource.grade);
    const assignmentName =
      str(r.title ?? r.assignmentName ?? r.assignment_name ?? assignmentObj?.name ?? (nestedSubmission ? r.name : undefined)) ??
      `Opdracht ${assignmentId}`;
    const dueAt = normalizeDateOrNull(r.dueAt ?? r.due_at ?? assignmentObj?.due_at);

    const statusLabel =
      workflowState === "unknown" || workflowState === "not_applicable"
        ? "Onbekend / niet van toepassing"
        : workflowState === "graded" && !submittedAt
          ? "graded (beoordeeld zonder inleverdatum / niet ingeleverd)"
          : workflowState;

    const statusParts: string[] = [`Status: ${statusLabel}`];
    if (submittedAt) statusParts.push(`Ingeleverd op: ${submittedAt}`);
    if (missing) statusParts.push("Gemarkeerd als ontbrekend");
    if (late) statusParts.push("Te laat ingeleverd");
    if (excused) statusParts.push("Vrijgesteld");
    if (grade !== null) statusParts.push(`Beoordeling: ${grade}`);
    else if (score !== null) statusParts.push(`Score: ${score}`);

    const fallbackUrl = expectedOrigin
      ? `${expectedOrigin}/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignmentId)}/submissions/self`
      : null;

    items.push({
      id: `canvas:submission:${courseId}:${assignmentId}`,
      category: "submissions",
      courseId,
      courseName: str(r.courseName ?? r.course_name) ?? courseNames.get(courseId) ?? null,
      title: `Inleverstatus: ${assignmentName}`,
      text: str(r.text) ? htmlToPlainText(str(r.text)) : statusParts.join(" · "),
      dueAt,
      startAt: null,
      endAt: null,
      submittedAt,
      updatedAt: normalizeDateOrNull(subSource.updatedAt ?? subSource.graded_at ?? subSource.posted_at),
      url: sanitizeCanvasUrl(subSource.url ?? subSource.html_url ?? subSource.preview_url ?? r.html_url, expectedOrigin) ?? fallbackUrl,
      retrievedAt: normalizeDateOrNull(r.retrievedAt ?? r.retrieved_at) ?? retrievedAt,
      workflowState,
      submitted,
      missing,
      late,
      excused,
      score,
      grade,
      assignmentId: assignmentId.replace(/^canvas:assignment:[^:]+:/, ""),
    });
  }

  return { items, truncated, warnings, retrievedAt, enrollmentStatus, enrollmentRoles };
}

export function normalizeAnnouncementsPayload(
  raw: unknown,
  allowedCourseIds: ReadonlySet<string>,
  courseNames: ReadonlyMap<string, string>,
  expectedOrigin?: string,
  nowIso = new Date().toISOString(),
): CanvasListResult<CanvasSourceItem> {
  const { list, truncated, warnings, retrievedAt } = parseEnvelope(raw, nowIso);
  const items: CanvasSourceItem[] = [];

  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    const rawId = str(r.id);
    if (!rawId) continue;
    const courseId = str(r.courseId ?? r.course_id) ?? extractCourseIdFromContext(r.context_code ?? r.contextCode);
    if (!courseId || !allowedCourseIds.has(courseId)) continue;

    const title = str(r.title) ?? `Announcement ${rawId}`;
    const text = htmlToPlainText(str(r.text ?? r.message));
    const postedAt = normalizeDateOrNull(r.startAt ?? r.posted_at ?? r.created_at);

    items.push({
      id: rawId.startsWith("canvas:") ? rawId : `canvas:announcement:${courseId}:${rawId}`,
      category: "announcements",
      courseId,
      courseName: str(r.courseName ?? r.course_name) ?? courseNames.get(courseId) ?? null,
      title,
      text,
      dueAt: null,
      startAt: postedAt,
      endAt: null,
      submittedAt: null,
      updatedAt: normalizeDateOrNull(r.updatedAt ?? r.posted_at),
      url: sanitizeCanvasUrl(r.url ?? r.html_url, expectedOrigin),
      retrievedAt: normalizeDateOrNull(r.retrievedAt ?? r.retrieved_at) ?? retrievedAt,
    });
  }

  return { items, truncated, warnings, retrievedAt };
}

export function normalizeCalendarEventsPayload(
  raw: unknown,
  allowedCourseIds: ReadonlySet<string>,
  courseNames: ReadonlyMap<string, string>,
  expectedOrigin?: string,
  nowIso = new Date().toISOString(),
): CanvasListResult<CanvasSourceItem> {
  const { list, truncated, warnings, retrievedAt } = parseEnvelope(raw, nowIso);
  const items: CanvasSourceItem[] = [];

  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    const rawId = str(r.id);
    if (!rawId) continue;
    // Never include assignment events in calendar reads (prevents indirect assignment fetching when assignments category is disabled)
    if (
      rawId.startsWith("assignment_") ||
      str(r.type) === "assignment" ||
      (r.assignment !== undefined && r.assignment !== null)
    ) {
      continue;
    }
    const courseId =
      str(r.courseId ?? r.course_id) ??
      extractCourseIdFromContext(r.effective_context_code ?? r.context_code ?? r.contextCode);
    if (!courseId || !allowedCourseIds.has(courseId)) continue;

    const title = str(r.title) ?? `Agenda-item ${rawId}`;
    const desc = htmlToPlainText(str(r.text ?? r.description));
    const loc = str(r.location_name ?? r.locationName);
    const text = [loc ? `Locatie: ${loc}` : "", desc].filter(Boolean).join("\n");

    items.push({
      id: rawId.startsWith("canvas:") ? rawId : `canvas:calendar:${courseId}:${rawId}`,
      category: "calendar",
      courseId,
      courseName: str(r.courseName ?? r.course_name ?? r.context_name) ?? courseNames.get(courseId) ?? null,
      title,
      text,
      dueAt: null,
      startAt: normalizeDateOrNull(r.startAt ?? r.start_at ?? r.all_day_date),
      endAt: normalizeDateOrNull(r.endAt ?? r.end_at),
      submittedAt: null,
      updatedAt: normalizeDateOrNull(r.updatedAt ?? r.updated_at),
      url: sanitizeCanvasUrl(r.url ?? r.html_url, expectedOrigin),
      retrievedAt: normalizeDateOrNull(r.retrievedAt ?? r.retrieved_at) ?? retrievedAt,
    });
  }

  return { items, truncated, warnings, retrievedAt };
}

/**
 * Normalizes modules and module items.
 * When `enabledCategories.assignments` is false, module items of type `Assignment` or `Quiz` are stripped
 * so disabled categories are never fetched indirectly through module expansion.
 */
export function normalizeModulesPayload(
  raw: unknown,
  allowedCourseId: string,
  enabledCategories: Readonly<Record<CanvasCategory, boolean>>,
  courseNames: ReadonlyMap<string, string>,
  expectedOrigin?: string,
  nowIso = new Date().toISOString(),
): CanvasListResult<CanvasSourceItem> {
  const { list, truncated, warnings, retrievedAt } = parseEnvelope(raw, nowIso);
  const items: CanvasSourceItem[] = [];

  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    const courseId = str(r.courseId ?? r.course_id) ?? allowedCourseId;
    if (courseId !== allowedCourseId) continue;

    // Supports both flat normalized module-item records and nested Canvas Module objects with `items: [...]`
    if (Array.isArray(r.items)) {
      const modId = str(r.id) ?? "module";
      const modName = str(r.name ?? r.title) ?? `Module ${modId}`;
      const modItems = r.items as unknown[];
      if (modItems.length === 0) {
        items.push({
          id: `canvas:module:${courseId}:${modId}`,
          category: "modules",
          courseId,
          courseName: courseNames.get(courseId) ?? null,
          title: modName,
          text: str(r.state) ? `Status: ${str(r.state)}` : "Module zonder zichtbare items.",
          dueAt: null,
          startAt: normalizeDateOrNull(r.unlock_at),
          endAt: null,
          submittedAt: null,
          updatedAt: null,
          url: expectedOrigin ? `${expectedOrigin}/courses/${encodeURIComponent(courseId)}/modules/${encodeURIComponent(modId)}` : null,
          retrievedAt,
          moduleId: modId,
          moduleName: modName,
          itemType: "Module",
        });
      }
      for (const sub of modItems) {
        if (typeof sub !== "object" || sub === null) continue;
        const item = sub as Record<string, unknown>;
        const itemId = str(item.id);
        if (!itemId) continue;
        const itemType = str(item.type ?? item.itemType) ?? "Item";
        if (!enabledCategories.assignments && (itemType === "Assignment" || itemType === "Quiz")) {
          continue;
        }
        const itemTitle = str(item.title) ?? `${itemType} ${itemId}`;
        const pageUrl = str(item.page_url ?? item.pageUrl);
        const comp =
          typeof item.completion_requirement === "object" && item.completion_requirement !== null
            ? (item.completion_requirement as Record<string, unknown>)
            : null;
        const completed = bool(comp?.completed) ?? null;
        const details: string[] = [`Module: ${modName}`, `Type: ${itemType}`];
        if (pageUrl) details.push(`Pagina: ${pageUrl}`);
        if (completed !== null) details.push(completed ? "Voltooid" : "Nog niet voltooid");

        items.push({
          id: `canvas:module-item:${courseId}:${modId}:${itemId}`,
          category: "modules",
          courseId,
          courseName: courseNames.get(courseId) ?? null,
          title: `${modName} — ${itemTitle}`,
          text: details.join(" · "),
          dueAt: null,
          startAt: null,
          endAt: null,
          submittedAt: null,
          updatedAt: null,
          url: sanitizeCanvasUrl(item.html_url ?? item.url, expectedOrigin),
          retrievedAt,
          moduleId: modId,
          moduleName: modName,
          itemType,
          pageUrl,
          completed,
        });
      }
      continue;
    }

    const rawId = str(r.id);
    if (!rawId) continue;
    const itemType = str(r.itemType ?? r.type) ?? "ModuleItem";
    if (!enabledCategories.assignments && (itemType === "Assignment" || itemType === "Quiz")) {
      continue;
    }
    const modId = str(r.moduleId ?? r.module_id);
    const modName = str(r.moduleName ?? r.module_name);
    items.push({
      id: rawId.startsWith("canvas:") ? rawId : `canvas:module-item:${courseId}:${modId ?? "0"}:${rawId}`,
      category: "modules",
      courseId,
      courseName: str(r.courseName ?? r.course_name) ?? courseNames.get(courseId) ?? null,
      title: str(r.title ?? r.name) ?? `Module-item ${rawId}`,
      text: htmlToPlainText(str(r.text ?? r.description)),
      dueAt: null,
      startAt: normalizeDateOrNull(r.startAt ?? r.unlock_at),
      endAt: null,
      submittedAt: null,
      updatedAt: normalizeDateOrNull(r.updatedAt ?? r.updated_at),
      url: sanitizeCanvasUrl(r.url ?? r.html_url, expectedOrigin),
      retrievedAt: normalizeDateOrNull(r.retrievedAt ?? r.retrieved_at) ?? retrievedAt,
      moduleId: modId,
      moduleName: modName,
      itemType,
      pageUrl: str(r.pageUrl ?? r.page_url),
      completed: bool(r.completed) ?? null,
    });
  }

  return { items, truncated, warnings, retrievedAt };
}

export function normalizePagePayload(
  raw: unknown,
  allowedCourseId: string,
  requestedSlug: string,
  courseNames: ReadonlyMap<string, string>,
  expectedOrigin?: string,
  nowIso = new Date().toISOString(),
): CanvasSourceItem {
  const { single, retrievedAt } = parseEnvelope(raw, nowIso);
  if (!single) {
    throw new CanvasMcpError("not-found", "Canvas-pagina niet gevonden.");
  }
  const courseId = str(single.courseId ?? single.course_id) ?? allowedCourseId;
  if (courseId !== allowedCourseId) {
    throw new CanvasMcpError("permission", "De ontvangen pagina hoort niet bij de aangevraagde cursus.");
  }
  const pageUrl = str(single.pageUrl ?? single.url ?? single.page_id) ?? requestedSlug;
  const title = str(single.title) ?? `Pagina ${pageUrl}`;
  const text = htmlToPlainText(str(single.text ?? single.body));
  const fallbackUrl = expectedOrigin
    ? `${expectedOrigin}/courses/${encodeURIComponent(courseId)}/pages/${encodeURIComponent(pageUrl)}`
    : null;

  return {
    id: str(single.id)?.startsWith("canvas:") ? str(single.id)! : `canvas:page:${courseId}:${pageUrl}`,
    category: "modules",
    courseId,
    courseName: str(single.courseName ?? single.course_name) ?? courseNames.get(courseId) ?? null,
    title,
    text,
    dueAt: null,
    startAt: null,
    endAt: null,
    submittedAt: null,
    updatedAt: normalizeDateOrNull(single.updatedAt ?? single.updated_at),
    url: sanitizeCanvasUrl(single.html_url ?? single.url, expectedOrigin) ?? fallbackUrl,
    retrievedAt: normalizeDateOrNull(single.retrievedAt ?? single.retrieved_at) ?? retrievedAt,
    itemType: "Page",
    pageUrl,
  };
}
