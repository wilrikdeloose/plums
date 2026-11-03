import { z } from "zod";

z.config(z.locales.nl());

export const SCHEMA_ID = "plums";
export const SCHEMA_VERSION = 2;

export const WEEKDAYS = ["ma", "di", "wo", "do", "vr", "za", "zo"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const CANVAS_CATEGORIES = [
  "assignments",
  "submissions",
  "announcements",
  "calendar",
  "modules",
] as const;
export type CanvasCategory = (typeof CANVAS_CATEGORIES)[number];

const isoDate = z.string().min(1);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Tijd moet HH:MM zijn");
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum moet YYYY-MM-DD zijn");

const fixedCommitment = z.object({
  id: z.string().min(1),
  day: z.enum(WEEKDAYS),
  start: time,
  end: time,
  description: z.string(),
});

const dayWindow = z.object({
  start: time,
  end: time,
});

const dateException = z.object({
  id: z.string().min(1),
  date: ymd,
  unavailable: z.boolean().optional(),
  windowStart: time.nullable().optional(),
  windowEnd: time.nullable().optional(),
  note: z.string().optional(),
});

const profile = z.object({
  name: z.string(),
  studyContext: z.string(),
  availableStudyHours: z.object(
    Object.fromEntries(WEEKDAYS.map((d) => [d, z.number().min(0).max(24)])) as Record<
      Weekday,
      z.ZodNumber
    >,
  ),
  /** Per-weekday study window; null means no study that day. */
  dayWindows: z.object({
    ma: dayWindow.nullable(),
    di: dayWindow.nullable(),
    wo: dayWindow.nullable(),
    do: dayWindow.nullable(),
    vr: dayWindow.nullable(),
    za: dayWindow.nullable(),
    zo: dayWindow.nullable(),
  }),
  dateExceptions: z.array(dateException).default([]),
  fixedCommitments: z.array(fixedCommitment),
  preferredBlockMinutes: z.number().int().min(15).max(240),
  breakMinutes: z.number().int().min(0).max(60).default(10),
});

const settings = z.object({
  personalization: z.object({
    systemInstructions: z.string(),
  }),
  ai: z.object({
    baseUrl: z.string(),
    model: z.string(),
  }),
  canvas: z.object({
    baseUrl: z.string(),
    selectedCourseIds: z.array(z.string()),
    categories: z.object(
      Object.fromEntries(CANVAS_CATEGORIES.map((c) => [c, z.boolean()])) as Record<
        CanvasCategory,
        z.ZodBoolean
      >,
    ),
    /** Courses whose submissions are read as the Canvas Test Student; honoured only in --testmode=true builds. */
    testStudentCourseIds: z.array(z.string()).default([]),
  }),
  mcp: z.object({
    mode: z.enum(["builtin", "remote"]),
    remoteUrl: z.string(),
  }),
});

export const REPLY_STATUSES = ["streaming", "completed", "stopped", "failed"] as const;

export const CANVAS_OPERATIONS_LIST = [
  "courses",
  "assignments",
  "submissions",
  "announcements",
  "calendar",
  "modules",
  "page",
] as const;

export const TOOL_OPERATIONS_LIST = [
  ...CANVAS_OPERATIONS_LIST,
  "plan_create",
  "plan_revise",
  "planning_clarify",
] as const;

export const canvasSourceRefSchema = z.object({
  id: z.string().min(1),
  category: z.enum(CANVAS_CATEGORIES),
  courseId: z.string().min(1),
  courseName: z.string().nullable().optional(),
  title: z.string().min(1),
  dueAt: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  retrievedAt: z.string().min(1),
  testStudent: z.boolean().optional(),
});

export const canvasProvenanceSchema = z.object({
  scopeId: z.string().min(1),
  courseIds: z.array(z.string()),
  categories: z.array(z.enum(CANVAS_CATEGORIES)),
  sourceIds: z.array(z.string()),
  /** Courses whose Canvas Test Student data contributed; such content is excluded outside test builds. */
  testStudentCourseIds: z.array(z.string()).optional(),
});

export const toolStepStatusSchema = z.enum([
  "running",
  "success",
  "empty",
  "partial",
  "not_applicable",
  "denied",
  "failed",
  "cancelled",
]);

export const toolStepSchema = z.object({
  id: z.string().min(1),
  operation: z.enum(TOOL_OPERATIONS_LIST),
  label: z.string().min(1),
  status: toolStepStatusSchema,
  detail: z.string().optional(),
  courseIds: z.array(z.string()),
  categories: z.array(z.enum(CANVAS_CATEGORIES)),
  testStudent: z.boolean().optional(),
});

const message = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: isoDate,
  /** Assistant replies only; missing means completed (older data). */
  status: z.enum(REPLY_STATUSES).optional(),
  /** Dutch, credential-free reason for a failed or stopped reply. */
  error: z.string().optional(),
  /** Provenance of Canvas data consulted to produce this assistant message. */
  canvasProvenance: canvasProvenanceSchema.optional(),
  /** Verified Canvas sources retrieved during this assistant turn (for clickable UI references). */
  sources: z.array(canvasSourceRefSchema).optional(),
  /** Tool activity steps executed during this assistant turn. */
  toolSteps: z.array(toolStepSchema).optional(),
  /** Saved plan produced by this assistant turn (validated local planning). */
  planId: z.string().optional(),
});

const conversation = z.object({
  id: z.string().min(1),
  title: z.string(),
  createdAt: isoDate,
  updatedAt: isoDate,
  messages: z.array(message),
  /** Latest active plan revision for follow-ups in this conversation. */
  activePlanId: z.string().nullable().optional(),
});

const ownTask = z.object({
  id: z.string().min(1),
  title: z.string(),
  notes: z.string(),
  dueAt: z.string().nullable(),
  estimateMinutes: z.number().int().min(0).nullable(),
  priority: z.enum(["hoog", "middel", "laag"]).default("middel"),
  done: z.boolean(),
  createdAt: isoDate,
});

const planBlock = z.object({
  id: z.string().min(1),
  date: z.string(),
  start: time,
  end: time,
  title: z.string(),
  priority: z.enum(["hoog", "middel", "laag"]),
  origin: z.enum(["canvas", "student", "ai-schatting"]),
  sourceRef: z.string().nullable(),
  taskId: z.string().nullable().optional(),
  dueAt: z.string().nullable().optional(),
  isBreak: z.boolean().optional(),
  estimateIsAi: z.boolean().optional(),
});

const unscheduledItem = z.object({
  id: z.string().min(1),
  title: z.string(),
  remainingMinutes: z.number().int().min(0),
  reason: z.string(),
  priority: z.enum(["hoog", "middel", "laag"]),
  dueAt: z.string().nullable(),
  origin: z.enum(["canvas", "student", "ai-schatting"]),
  sourceRef: z.string().nullable(),
});

const oneOffConstraint = z.object({
  id: z.string().min(1),
  type: z.enum(["date_unavailable", "reduce_load"]),
  date: ymd.optional(),
  note: z.string(),
});

const plan = z.object({
  id: z.string().min(1),
  title: z.string(),
  scope: z.enum(["dag", "week"]),
  startDate: z.string(),
  conversationId: z.string().nullable(),
  messageId: z.string().nullable().optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
  blocks: z.array(planBlock),
  status: z.enum(["complete", "partial"]).default("complete"),
  revision: z.number().int().min(1).default(1),
  supersedesPlanId: z.string().nullable().optional(),
  assumptions: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  unscheduled: z.array(unscheduledItem).default([]),
  capacityShortfallMinutes: z.number().int().min(0).default(0),
  oneOffConstraints: z.array(oneOffConstraint).default([]),
  canvasProvenance: canvasProvenanceSchema.optional(),
  /** Set when Canvas Test Student data contributed; such plans are excluded outside test builds. */
  testStudentCourseIds: z.array(z.string()).optional(),
});

/** Unknown keys are stripped, so secrets or stray fields never survive load, import or export. */
export const appDataSchema = z.object({
  schema: z.literal(SCHEMA_ID),
  version: z.literal(SCHEMA_VERSION),
  settings,
  profile,
  conversations: z.array(conversation),
  ownTasks: z.array(ownTask),
  plans: z.array(plan),
});

export type AppData = z.infer<typeof appDataSchema>;
export type Settings = AppData["settings"];
export type Profile = AppData["profile"];
export type Conversation = AppData["conversations"][number];
export type Message = Conversation["messages"][number];
export type ReplyStatus = (typeof REPLY_STATUSES)[number];
export type FixedCommitment = Profile["fixedCommitments"][number];
export type DateException = Profile["dateExceptions"][number];
export type OwnTask = AppData["ownTasks"][number];
export type Plan = AppData["plans"][number];
export type PlanBlock = Plan["blocks"][number];
export type McpMode = Settings["mcp"]["mode"];
export type CanvasSourceRef = z.infer<typeof canvasSourceRefSchema>;
export type CanvasProvenance = z.infer<typeof canvasProvenanceSchema>;
export type ToolStep = z.infer<typeof toolStepSchema>;
export type ToolStepStatus = z.infer<typeof toolStepStatusSchema>;

function defaultDayWindowsFromHours(
  hours: Record<Weekday, number>,
): Profile["dayWindows"] {
  const out = {} as Profile["dayWindows"];
  for (const d of WEEKDAYS) {
    const h = hours[d] ?? 0;
    if (h <= 0) {
      out[d] = null;
    } else {
      const endMin = 9 * 60 + Math.round(h * 60);
      const eh = Math.min(23, Math.floor(endMin / 60));
      const em = endMin % 60;
      out[d] = {
        start: "09:00",
        end: `${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`,
      };
    }
  }
  return out;
}

export function createDefaultData(builtInMcp: boolean): AppData {
  const availableStudyHours = { ma: 6, di: 6, wo: 6, do: 6, vr: 6, za: 0, zo: 0 };
  return {
    schema: SCHEMA_ID,
    version: SCHEMA_VERSION,
    settings: {
      personalization: { systemInstructions: "" },
      ai: { baseUrl: "", model: "" },
      canvas: {
        baseUrl: "https://fhict.instructure.com",
        selectedCourseIds: [],
        categories: {
          assignments: true,
          submissions: true,
          announcements: true,
          calendar: true,
          modules: true,
        },
        testStudentCourseIds: [],
      },
      mcp: { mode: builtInMcp ? "builtin" : "remote", remoteUrl: "" },
    },
    profile: {
      name: "",
      studyContext: "",
      availableStudyHours,
      dayWindows: defaultDayWindowsFromHours(availableStudyHours),
      dateExceptions: [],
      fixedCommitments: [],
      preferredBlockMinutes: 50,
      breakMinutes: 10,
    },
    conversations: [],
    ownTasks: [],
    plans: [],
  };
}

/** Migrates a v1 document object in place toward v2 shape before Zod parse. */
export function migrateAppDataRaw(raw: Record<string, unknown>): { version: number; notes: string[] } {
  const notes: string[] = [];
  let version = typeof raw.version === "number" ? raw.version : 0;
  if (version === 1) {
    const profile = (raw.profile ?? {}) as Record<string, unknown>;
    const hours = (profile.availableStudyHours ?? {}) as Record<string, number>;
    if (!profile.dayWindows) {
      profile.dayWindows = defaultDayWindowsFromHours({
        ma: Number(hours.ma) || 0,
        di: Number(hours.di) || 0,
        wo: Number(hours.wo) || 0,
        do: Number(hours.do) || 0,
        vr: Number(hours.vr) || 0,
        za: Number(hours.za) || 0,
        zo: Number(hours.zo) || 0,
      });
      notes.push("Studietijdvensters afgeleid van bestaande studie-uren (schema v2).");
    }
    if (profile.dateExceptions === undefined) profile.dateExceptions = [];
    if (profile.breakMinutes === undefined) profile.breakMinutes = 10;
    raw.profile = profile;

    const ownTasks = Array.isArray(raw.ownTasks) ? raw.ownTasks : [];
    for (const t of ownTasks) {
      if (t && typeof t === "object" && !("priority" in t)) {
        (t as Record<string, unknown>).priority = "middel";
      }
    }
    raw.ownTasks = ownTasks;

    const plans = Array.isArray(raw.plans) ? raw.plans : [];
    for (const p of plans) {
      if (!p || typeof p !== "object") continue;
      const plan = p as Record<string, unknown>;
      if (plan.status === undefined) plan.status = "complete";
      if (plan.revision === undefined) plan.revision = 1;
      if (plan.assumptions === undefined) plan.assumptions = [];
      if (plan.warnings === undefined) plan.warnings = [];
      if (plan.unscheduled === undefined) plan.unscheduled = [];
      if (plan.capacityShortfallMinutes === undefined) plan.capacityShortfallMinutes = 0;
      if (plan.oneOffConstraints === undefined) plan.oneOffConstraints = [];
    }
    raw.plans = plans;
    raw.version = 2;
    version = 2;
    notes.push("Gegevens bijgewerkt van schemaversie 1 naar 2 (planning).");
  }
  return { version, notes };
}

export type ValidationResult =
  | { ok: true; data: AppData; notes: string[] }
  | { ok: false; error: string };

/**
 * Validates a stored or imported document and adapts it to the current platform.
 * Outside an agreeing test build, saved or imported Test Student settings are discarded.
 */
export function validateAppData(raw: unknown, builtInMcp: boolean, canvasTestStudent = false): ValidationResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "Het bestand bevat geen PLuMS-gegevensobject." };
  }
  const head = raw as { schema?: unknown; version?: unknown };
  if (head.schema !== SCHEMA_ID) {
    return { ok: false, error: "Dit is geen PLuMS-gegevensbestand (veld \"schema\" ontbreekt of klopt niet)." };
  }
  if (typeof head.version !== "number") {
    return { ok: false, error: "Het veld \"version\" ontbreekt." };
  }
  const mutable = structuredClone(raw) as Record<string, unknown>;
  const migrated = migrateAppDataRaw(mutable);
  if (migrated.version !== SCHEMA_VERSION) {
    return {
      ok: false,
      error: `Schemaversie ${head.version} wordt niet ondersteund (deze versie van PLuMS gebruikt versie ${SCHEMA_VERSION}).`,
    };
  }
  const parsed = appDataSchema.safeParse(mutable);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `Ongeldige gegevens: ${issues}` };
  }
  const data = parsed.data;
  const notes: string[] = [...migrated.notes];
  for (const conversation of data.conversations) {
    for (const m of conversation.messages) {
      if (m.status === "streaming") {
        m.status = "failed";
        m.error = "Onderbroken: de app werd gesloten of herladen tijdens het antwoord. Dit antwoord is onvolledig.";
      }
    }
  }
  if (!builtInMcp && data.settings.mcp.mode === "builtin") {
    data.settings.mcp.mode = "remote";
    notes.push("De ingebouwde Canvas MCP is niet beschikbaar in de browser; de MCP-modus is op extern gezet.");
  }
  if (!canvasTestStudent && data.settings.canvas.testStudentCourseIds.length > 0) {
    data.settings.canvas.testStudentCourseIds = [];
    notes.push("Canvas Test Student-instellingen zijn genegeerd: deze versie is geen testbuild.");
  }
  return { ok: true, data, notes };
}

/** Serializes only the allowed, non-secret schema as readable JSON. */
export function serializeAppData(data: AppData): string {
  return JSON.stringify(appDataSchema.parse(data), null, 2) + "\n";
}
