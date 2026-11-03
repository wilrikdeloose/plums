import { z } from "zod";
import { CANVAS_CATEGORIES, type CanvasCategory } from "../schema";
import {
  CANVAS_OPERATIONS,
  CanvasMcpError,
  OPERATION_CATEGORY,
  OPERATION_LABELS,
  type CanvasOperation,
  type McpToolDescriptor,
} from "./types";

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_PAGE_LOCATOR = /^[A-Za-z0-9_.:%-]{1,160}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;

export const courseIdSchema = z
  .string()
  .trim()
  .regex(SAFE_ID, "Ongeldig cursus-ID.");

export const assignmentIdSchema = z
  .string()
  .trim()
  .regex(SAFE_ID, "Ongeldig opdracht-ID.");

export const pageSlugSchema = z
  .string()
  .trim()
  .regex(SAFE_PAGE_LOCATOR, "Ongeldige pagina-identificatie.")
  .refine((v) => !v.includes("..") && !v.includes("/") && !v.includes("\\"), "Ongeldige pagina-identificatie.");

export const optionalIsoDateSchema = z
  .string()
  .trim()
  .regex(ISO_DATE, "Datum moet YYYY-MM-DD of ISO-8601 zijn.")
  .optional();

/** Reviewed canonical tool names exposed by the built-in server and accepted on remote servers. */
export const CANONICAL_TOOLS: Record<CanvasOperation, string> = {
  courses: "canvas_list_courses",
  assignments: "canvas_list_assignments",
  submissions: "canvas_get_own_submissions",
  announcements: "canvas_list_announcements",
  calendar: "canvas_list_calendar_events",
  modules: "canvas_list_modules",
  page: "canvas_get_page",
};

interface ReviewedToolSpec {
  operation: CanvasOperation;
  acceptedNames: readonly string[];
  courseBoundary: "none" | "single" | "multi";
  requiredParams: readonly string[];
  allowedParams: readonly string[];
}

const REVIEWED_SPECS: readonly ReviewedToolSpec[] = [
  {
    operation: "courses",
    acceptedNames: ["canvas_list_courses", "list_courses"],
    courseBoundary: "none",
    requiredParams: [],
    allowedParams: [],
  },
  {
    operation: "assignments",
    acceptedNames: ["canvas_list_assignments", "list_assignments"],
    courseBoundary: "single",
    requiredParams: ["course_id"],
    allowedParams: ["course_id", "bucket", "search_term"],
  },
  {
    operation: "submissions",
    acceptedNames: ["canvas_get_own_submissions", "list_own_submissions", "get_own_submissions"],
    courseBoundary: "single",
    requiredParams: ["course_id"],
    allowedParams: ["course_id", "assignment_ids"],
  },
  {
    operation: "announcements",
    acceptedNames: ["canvas_list_announcements", "list_announcements"],
    courseBoundary: "multi",
    requiredParams: ["course_ids"],
    allowedParams: ["course_ids", "start_date", "end_date"],
  },
  {
    operation: "calendar",
    acceptedNames: ["canvas_list_calendar_events", "list_calendar_events"],
    courseBoundary: "multi",
    requiredParams: ["course_ids"],
    allowedParams: ["course_ids", "start_date", "end_date"],
  },
  {
    operation: "modules",
    acceptedNames: ["canvas_list_modules", "list_modules"],
    courseBoundary: "single",
    requiredParams: ["course_id"],
    allowedParams: ["course_id", "search_term"],
  },
  {
    operation: "page",
    acceptedNames: ["canvas_get_page", "get_page"],
    courseBoundary: "single",
    requiredParams: ["course_id", "page_url_or_id"],
    allowedParams: ["course_id", "page_url_or_id"],
  },
];

export const TEST_STUDENT_TOOL = "canvas_get_test_student_submissions";

/** Reviewed only for agreeing test builds; the server resolves the Test Student itself, so no user parameter exists. */
const TEST_STUDENT_SPEC: ReviewedToolSpec = {
  operation: "submissions",
  acceptedNames: [TEST_STUDENT_TOOL],
  courseBoundary: "single",
  requiredParams: ["course_id"],
  allowedParams: ["course_id", "assignment_ids"],
};

/** Suspicious parameter names that indicate a remote tool could access arbitrary users or perform arbitrary requests. */
const FORBIDDEN_SCHEMA_PROPERTIES = new Set([
  "user_id",
  "student_id",
  "student_ids",
  "as_user_id",
  "url",
  "endpoint",
  "path",
  "method",
  "body",
  "command",
  "shell",
  "code",
  "script",
  "query",
]);

const WRITE_NAME_PATTERN = /(create|update|delete|destroy|submit|grade|upload|post|put|patch|remove|edit|duplicate|revert|relock|mark_as_done|exec|run|shell|http|fetch)/i;

export interface MappedTool {
  operation: CanvasOperation;
  toolName: string;
  description: string;
}

export interface RejectedTool {
  name: string;
  reason: string;
}

export interface CapabilityMap {
  mapped: Partial<Record<CanvasOperation, MappedTool>>;
  missingOperations: CanvasOperation[];
  rejectedTools: RejectedTool[];
  /** Mapped only when the caller allows the Test Student exception (agreeing test build). */
  testStudentTool?: MappedTool;
}

function getSchemaProperties(inputSchema: Record<string, unknown> | undefined): Record<string, Record<string, unknown>> | null {
  if (!inputSchema || typeof inputSchema !== "object") return null;
  if (inputSchema.type !== undefined && inputSchema.type !== "object") return null;
  const props = inputSchema.properties;
  if (props === undefined) return {};
  if (typeof props !== "object" || props === null || Array.isArray(props)) return null;
  return props as Record<string, Record<string, unknown>>;
}

function validateToolAgainstSpec(tool: McpToolDescriptor, spec: ReviewedToolSpec): { ok: true } | { ok: false; reason: string } {
  if (WRITE_NAME_PATTERN.test(tool.name)) {
    return { ok: false, reason: "Schrijf- of generieke toolnaam is geblokkeerd." };
  }
  if (tool.annotations?.destructiveHint === true) {
    return { ok: false, reason: "Tool heeft destructiveHint=true en is geblokkeerd." };
  }
  if (tool.annotations?.readOnlyHint === false) {
    return { ok: false, reason: "Tool heeft readOnlyHint=false en is geblokkeerd." };
  }

  const props = getSchemaProperties(tool.inputSchema);
  if (!props) {
    return { ok: false, reason: "Tool-inputSchema is geen geldig JSON-objectschema." };
  }

  for (const propName of Object.keys(props)) {
    if (FORBIDDEN_SCHEMA_PROPERTIES.has(propName.toLowerCase())) {
      return {
        ok: false,
        reason: `Parameter "${propName}" is niet toegestaan (risico op toegang buiten eigen account of veilige grenzen).`,
      };
    }
    if (!spec.allowedParams.includes(propName)) {
      return {
        ok: false,
        reason: `Onbekende parameter "${propName}" wijkt af van het gecontroleerde leesschema.`,
      };
    }
  }

  for (const reqParam of spec.requiredParams) {
    const prop = props[reqParam];
    if (!prop) {
      return {
        ok: false,
        reason: `Verplichte cursus-/grens-parameter "${reqParam}" ontbreekt in het schema.`,
      };
    }
    if (reqParam === "course_ids" && prop.type !== undefined && prop.type !== "array") {
      return {
        ok: false,
        reason: `Parameter "course_ids" moet van het type array zijn om cursusgrenzen af te dwingen.`,
      };
    }
    if ((reqParam === "course_id" || reqParam === "page_url_or_id") && prop.type !== undefined && prop.type !== "string") {
      return {
        ok: false,
        reason: `Parameter "${reqParam}" moet van het type string zijn.`,
      };
    }
  }

  return { ok: true };
}

/**
 * Inspects discovered MCP tools and maps only explicitly reviewed read-tool schemas.
 * Unknown tools, write tools, and tools that cannot honor course/category/own-user boundaries are rejected.
 * `readOnlyHint` alone is never trusted to approve an unknown tool.
 */
export function mapDiscoveredTools(
  tools: readonly McpToolDescriptor[],
  options: { allowTestStudent?: boolean } = {},
): CapabilityMap {
  const mapped: Partial<Record<CanvasOperation, MappedTool>> = {};
  const rejectedTools: RejectedTool[] = [];
  let testStudentTool: MappedTool | undefined;

  for (const tool of tools) {
    if (options.allowTestStudent && tool.name === TEST_STUDENT_TOOL) {
      const check = validateToolAgainstSpec(tool, TEST_STUDENT_SPEC);
      if (check.ok) {
        testStudentTool = {
          operation: "submissions",
          toolName: tool.name,
          description: tool.description ?? "Canvas Test Student",
        };
      } else {
        rejectedTools.push({ name: tool.name, reason: check.reason });
      }
      continue;
    }
    const spec = REVIEWED_SPECS.find((s) => s.acceptedNames.includes(tool.name));
    if (!spec) {
      const hintNote = tool.annotations?.readOnlyHint
        ? " (niet op de gecontroleerde lijst; alleen readOnlyHint is onvoldoende bewijs)"
        : " (onbekende of niet-ondersteunde tool)";
      rejectedTools.push({
        name: tool.name,
        reason: `Geblokkeerd${hintNote}.`,
      });
      continue;
    }

    const check = validateToolAgainstSpec(tool, spec);
    if (!check.ok) {
      rejectedTools.push({ name: tool.name, reason: check.reason });
      continue;
    }

    // Prefer the canonical `canvas_*` tool name if both canonical and alias are present
    const existing = mapped[spec.operation];
    if (!existing || tool.name === CANONICAL_TOOLS[spec.operation]) {
      mapped[spec.operation] = {
        operation: spec.operation,
        toolName: tool.name,
        description: tool.description ?? OPERATION_LABELS[spec.operation],
      };
    }
  }

  const missingOperations = CANVAS_OPERATIONS.filter((op) => !mapped[op]);
  return testStudentTool
    ? { mapped, missingOperations, rejectedTools, testStudentTool }
    : { mapped, missingOperations, rejectedTools };
}

export interface ReadPermissions {
  selectedCourseIds: readonly string[];
  categories: Readonly<Record<CanvasCategory, boolean>>;
  /** Effective Test Student courses; always empty outside agreeing test builds. */
  testStudentCourseIds?: readonly string[];
}

/**
 * Verifies that an operation is permitted by the current category toggles.
 */
export function isOperationPermitted(operation: CanvasOperation, permissions: ReadPermissions): boolean {
  const category = OPERATION_CATEGORY[operation];
  return category === null || Boolean(permissions.categories[category]);
}

export function assertOperationPermitted(operation: CanvasOperation, permissions: ReadPermissions): void {
  const category = OPERATION_CATEGORY[operation];
  if (category !== null && !permissions.categories[category]) {
    throw new CanvasMcpError(
      "permission",
      `De categorie "${OPERATION_LABELS[operation]}" is uitgeschakeld in Instellingen → Canvas.`,
    );
  }
}

/**
 * Verifies that a requested course ID is valid and selected by the user.
 */
export function assertCoursePermitted(courseId: string, permissions: ReadPermissions): string {
  const parsed = courseIdSchema.safeParse(courseId);
  if (!parsed.success) {
    throw new CanvasMcpError("permission", "Ongeldig cursus-ID.");
  }
  const selected = new Set(permissions.selectedCourseIds);
  if (!selected.has(parsed.data)) {
    throw new CanvasMcpError(
      "permission",
      `Cursus ${parsed.data} is niet geselecteerd in Instellingen → Canvas en mag niet worden gelezen.`,
    );
  }
  return parsed.data;
}

/**
 * Verifies that a list of course IDs is non-empty, valid, and each is in `selectedCourseIds`.
 * Caps at 10 courses per Canvas API `context_codes[]` rules.
 */
export function assertCoursesPermitted(courseIds: readonly string[], permissions: ReadPermissions): string[] {
  if (courseIds.length === 0) {
    throw new CanvasMcpError("permission", "Selecteer eerst ten minste één cursus in Instellingen → Canvas.");
  }
  const unique = [...new Set(courseIds.map((id) => assertCoursePermitted(id, permissions)))];
  return unique.slice(0, 10);
}

/**
 * Produces a stable signature string for the current Canvas/MCP read permissions so
 * any permission change can cancel in-flight calls and invalidate cached results.
 */
export function permissionSignature(
  mode: "builtin" | "remote",
  endpointUrl: string,
  permissions: ReadPermissions,
): string {
  const courses = [...permissions.selectedCourseIds].sort().join(",");
  const cats = CANVAS_CATEGORIES.filter((c) => permissions.categories[c]).join(",");
  const test = [...(permissions.testStudentCourseIds ?? [])].sort().join(",");
  return `${mode}|${endpointUrl}|courses:${courses}|cats:${cats}|test:${test}`;
}
