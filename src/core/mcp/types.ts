import { z } from "zod";
import { CANVAS_CATEGORIES, type CanvasCategory } from "../schema";

export const CANVAS_OPERATIONS = [
  "courses",
  "assignments",
  "submissions",
  "announcements",
  "calendar",
  "modules",
  "page",
] as const;

export type CanvasOperation = (typeof CANVAS_OPERATIONS)[number];

/** Which user-toggleable category gates each operation (`courses` is always allowed when Canvas is used). */
export const OPERATION_CATEGORY: Record<CanvasOperation, CanvasCategory | null> = {
  courses: null,
  assignments: "assignments",
  submissions: "submissions",
  announcements: "announcements",
  calendar: "calendar",
  modules: "modules",
  page: "modules",
};

export const OPERATION_LABELS: Record<CanvasOperation, string> = {
  courses: "Cursussen",
  assignments: "Opdrachten en deadlines",
  submissions: "Eigen inleverstatus",
  announcements: "Announcements",
  calendar: "Agenda-items",
  modules: "Modules en module-items",
  page: "Paginatekst",
};

export const CATEGORY_LABELS: Record<CanvasCategory, string> = {
  assignments: "Opdrachten en deadlines",
  submissions: "Eigen inleverstatus",
  announcements: "Announcements",
  calendar: "Agenda-items",
  modules: "Modules en pagina's",
};

export const canvasCourseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  courseCode: z.string().nullable(),
  workflowState: z.string().nullable(),
  startAt: z.string().nullable(),
  endAt: z.string().nullable(),
  url: z.string().nullable(),
  retrievedAt: z.string().min(1),
});

export type CanvasCourse = z.infer<typeof canvasCourseSchema>;

export const canvasSourceItemSchema = z.object({
  /** Stable normalized source ID, e.g. `canvas:assignment:123:456`. */
  id: z.string().min(1),
  category: z.enum(CANVAS_CATEGORIES),
  courseId: z.string().min(1),
  courseName: z.string().nullable(),
  title: z.string().min(1),
  /** Safe plain-text representation (HTML stripped). */
  text: z.string(),
  /** Effective user-specific due date (ISO string) or null when missing/not applicable. */
  dueAt: z.string().nullable(),
  startAt: z.string().nullable(),
  endAt: z.string().nullable(),
  submittedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /** Real Canvas web URL when available. */
  url: z.string().nullable(),
  retrievedAt: z.string().min(1),
  // Category-specific normalized fields:
  pointsPossible: z.number().nullable().optional(),
  submissionTypes: z.array(z.string()).optional(),
  workflowState: z.string().nullable().optional(),
  submitted: z.boolean().optional(),
  missing: z.boolean().optional(),
  late: z.boolean().optional(),
  excused: z.boolean().optional(),
  score: z.number().nullable().optional(),
  grade: z.string().nullable().optional(),
  assignmentId: z.string().nullable().optional(),
  moduleId: z.string().nullable().optional(),
  moduleName: z.string().nullable().optional(),
  itemType: z.string().nullable().optional(),
  pageUrl: z.string().nullable().optional(),
  completed: z.boolean().nullable().optional(),
  /** Read as the course's Canvas Test Student (test builds only), not as the signed-in user. */
  testStudent: z.boolean().optional(),
});

export type CanvasSourceItem = z.infer<typeof canvasSourceItemSchema>;

export const canvasReadMetaSchema = z.object({
  truncated: z.boolean(),
  warnings: z.array(z.string()),
  retrievedAt: z.string().min(1),
  enrollmentStatus: z.string().optional(),
  enrollmentRoles: z.array(z.string()).optional(),
  testStudent: z.boolean().optional(),
});

export type CanvasReadMeta = z.infer<typeof canvasReadMetaSchema>;

export interface CanvasListResult<T> extends CanvasReadMeta {
  items: T[];
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}

export interface McpDiscoveryResult {
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
  tools: McpToolDescriptor[];
}

export interface McpToolCallResult {
  isError: boolean;
  structuredContent?: unknown;
  textContent: string;
}

export type McpErrorKind =
  | "config"
  | "missing-secret"
  | "auth"
  | "forbidden"
  | "not-found"
  | "rate-limit"
  | "network"
  | "timeout"
  | "protocol"
  | "permission"
  | "unsupported"
  | "aborted";

export class CanvasMcpError extends Error {
  constructor(
    readonly kind: McpErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "CanvasMcpError";
  }
}

export interface McpTargetConfig {
  mode: "builtin" | "remote";
  /** Normalized Canvas base URL (builtin) or normalized remote MCP URL (remote). */
  endpointUrl: string;
  /** Current permissions enforced at the protocol/server boundary as well as in shared TS. */
  permissions: {
    selectedCourseIds: string[];
    categories: Record<CanvasCategory, boolean>;
    /** Sent only by agreeing test builds; a normal native build ignores it. */
    testStudentCourseIds?: string[];
  };
}

/**
 * Low-level platform MCP client injected at startup.
 * Desktop supports both `builtin` (embedded rmcp server over in-process duplex transport)
 * and `remote` (rmcp Streamable HTTP client).
 * Browser supports `remote` (official @modelcontextprotocol/client Streamable HTTP transport).
 */
export interface McpClient {
  discover(target: McpTargetConfig, signal?: AbortSignal): Promise<McpDiscoveryResult>;
  callTool(
    target: McpTargetConfig,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult>;
  disconnect(mode?: "builtin" | "remote"): Promise<void>;
}
