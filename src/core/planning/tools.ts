import { z } from "zod";
import { newId } from "../conversations";
import type { DataController } from "../dataController";
import type { ActiveCanvasScope } from "../mcp/provenance";
import { isPlanAllowed } from "../mcp/provenance";
import type { AppData, CanvasProvenance, Plan, ToolStep } from "../schema";
import type { ChatToolSpec } from "../ai/client";
import { allocatePlan, type ProposedTask } from "./allocate";
import type { BusyBlock } from "./availability";
import { formatPlanMarkdown } from "./format";
import { isValidYmd, mondayOfAmsterdamWeek } from "./time";
import { validateAllocatedPlan } from "./validate";

export const PLANNING_TOOL_NAMES = [
  "planning_ask_clarification",
  "planning_create_plan",
  "planning_revise_plan",
] as const;

export type PlanningToolName = (typeof PLANNING_TOOL_NAMES)[number];

export function isPlanningToolName(name: string): name is PlanningToolName {
  return (PLANNING_TOOL_NAMES as readonly string[]).includes(name);
}

export function buildPlanningTools(): ChatToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "planning_ask_clarification",
        description:
          "Stel ÉÉN beknopte, gegroepeerde verduidelijkingsvraag wanneer essentiële beschikbaarheid of tijdsinschattingen ontbreken om een haalbare dag/weekplanning te maken. Gebruik dit niet voor Canvas-feiten.",
        parameters: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "Eén gegroepeerde vraag in het Nederlands.",
            },
          },
          required: ["question"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "planning_create_plan",
        description:
          "Maak een gevalideerde dag- of weekplanning via de lokale allocator. Lever taken met geverifieerde Canvas-deadlines waar van toepassing; markeer AI-tijdsinschattingen expliciet. Slaat de planning op na validatie. Verzin geen deadlines en verschuif geen uren/deadlines bij tekort.",
        parameters: {
          type: "object",
          properties: {
            scope: { type: "string", enum: ["dag", "week"] },
            start_date: {
              type: "string",
              description: "YYYY-MM-DD in Europe/Amsterdam (voor week: willekeurige dag in die week).",
            },
            title: { type: "string" },
            tasks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  title: { type: "string" },
                  remaining_minutes: { type: "integer" },
                  priority: { type: "string", enum: ["hoog", "middel", "laag"] },
                  due_at: { type: ["string", "null"] },
                  origin: { type: "string", enum: ["canvas", "student", "ai-schatting"] },
                  source_ref: { type: ["string", "null"] },
                  estimate_is_ai: { type: "boolean" },
                  done: { type: "boolean" },
                },
                required: ["id", "title", "remaining_minutes", "priority", "origin"],
                additionalProperties: false,
              },
            },
            busy: {
              type: "array",
              description: "Bevestigde timed events (agenda) die studietijd blokkeren — geen announcements.",
              items: {
                type: "object",
                properties: {
                  date: { type: "string" },
                  start: { type: "string" },
                  end: { type: "string" },
                  title: { type: "string" },
                },
                required: ["date", "start", "end", "title"],
                additionalProperties: false,
              },
            },
            assumptions: { type: "array", items: { type: "string" } },
            warnings: {
              type: "array",
              items: { type: "string" },
              description: "Bijv. onbekende inleverstatus, mislukte Canvas-leesactie, testaccount-beperkingen.",
            },
            include_completed: { type: "boolean" },
          },
          required: ["scope", "start_date", "tasks"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "planning_revise_plan",
        description:
          "Herzie de actieve planning met eenmalige beperkingen (bijv. 'woensdag kan ik niet' of 'maak het rustiger') zonder het permanente profiel te overschrijven. Slaat een nieuwe revisie op.",
        parameters: {
          type: "object",
          properties: {
            plan_id: {
              type: "string",
              description: "Optioneel; default = actieve planning van dit gesprek.",
            },
            unavailable_dates: {
              type: "array",
              items: { type: "string" },
              description: "YYYY-MM-DD datums die voor deze planning eenmalig niet beschikbaar zijn.",
            },
            reduce_load_note: {
              type: "string",
              description: "Als de student rustiger wil: korte toelichting; verlaagt AI/open schattingen met 25%.",
            },
            extra_tasks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  title: { type: "string" },
                  remaining_minutes: { type: "integer" },
                  priority: { type: "string", enum: ["hoog", "middel", "laag"] },
                  due_at: { type: ["string", "null"] },
                  origin: { type: "string", enum: ["canvas", "student", "ai-schatting"] },
                  source_ref: { type: ["string", "null"] },
                  estimate_is_ai: { type: "boolean" },
                },
                required: ["id", "title", "remaining_minutes", "priority", "origin"],
                additionalProperties: false,
              },
            },
            assumptions: { type: "array", items: { type: "string" } },
            warnings: { type: "array", items: { type: "string" } },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
  ];
}

const clarifySchema = z.object({ question: z.string().min(1).max(800) }).strip();

const taskSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).max(300),
    remaining_minutes: z.number().int().positive().max(24 * 60),
    priority: z.enum(["hoog", "middel", "laag"]),
    due_at: z.string().nullable().optional(),
    origin: z.enum(["canvas", "student", "ai-schatting"]),
    source_ref: z.string().nullable().optional(),
    estimate_is_ai: z.boolean().optional(),
    done: z.boolean().optional(),
  })
  .strip();

const createSchema = z
  .object({
    scope: z.enum(["dag", "week"]),
    start_date: z.string(),
    title: z.string().max(200).optional(),
    tasks: z.array(taskSchema).min(1).max(40),
    busy: z
      .array(
        z
          .object({
            date: z.string(),
            start: z.string(),
            end: z.string(),
            title: z.string(),
          })
          .strip(),
      )
      .max(40)
      .optional(),
    assumptions: z.array(z.string().max(400)).max(20).optional(),
    warnings: z.array(z.string().max(400)).max(30).optional(),
    include_completed: z.boolean().optional(),
  })
  .strip();

const reviseSchema = z
  .object({
    plan_id: z.string().optional(),
    unavailable_dates: z.array(z.string()).max(14).optional(),
    reduce_load_note: z.string().max(400).optional(),
    extra_tasks: z.array(taskSchema).max(20).optional(),
    assumptions: z.array(z.string().max(400)).max(20).optional(),
    warnings: z.array(z.string().max(400)).max(30).optional(),
  })
  .strip();

export interface PlanningToolOutcome {
  toolCallId: string;
  content: string;
  step: ToolStep;
  planId?: string;
  savedPlan?: Plan;
}

function deny(callId: string, operation: ToolStep["operation"], label: string, detail: string): PlanningToolOutcome {
  return {
    toolCallId: callId,
    content: JSON.stringify({ status: "denied", error: detail }),
    step: {
      id: callId,
      operation,
      label,
      status: "denied",
      detail,
      courseIds: [],
      categories: [],
    },
  };
}

function toProposed(t: z.infer<typeof taskSchema>): ProposedTask {
  return {
    id: t.id,
    title: t.title,
    remainingMinutes: t.remaining_minutes,
    priority: t.priority,
    dueAt: t.due_at ?? null,
    origin: t.origin,
    sourceRef: t.source_ref ?? null,
    estimateIsAi: t.estimate_is_ai ?? t.origin === "ai-schatting",
    done: t.done,
  };
}

function persistPlan(
  controller: DataController,
  conversationId: string,
  plan: Plan,
  assistantMessageId: string,
): void {
  controller.update((d) => {
    d.plans.push(plan);
    const conv = d.conversations.find((c) => c.id === conversationId);
    if (conv) {
      conv.activePlanId = plan.id;
      conv.updatedAt = new Date().toISOString();
    }
    const msg = conv?.messages.find((m) => m.id === assistantMessageId);
    if (msg) msg.planId = plan.id;
  }, { immediate: true });
}

function tasksFromExistingPlan(plan: Plan): ProposedTask[] {
  const byTask = new Map<string, ProposedTask>();
  for (const b of plan.blocks) {
    if (b.isBreak || !b.taskId) continue;
    const existing = byTask.get(b.taskId);
    const mins =
      (existing?.remainingMinutes ?? 0) +
      (minutesBetween(b.start, b.end));
    byTask.set(b.taskId, {
      id: b.taskId,
      title: b.title,
      remainingMinutes: mins,
      priority: b.priority,
      dueAt: b.dueAt ?? null,
      origin: b.origin,
      sourceRef: b.sourceRef,
      estimateIsAi: b.estimateIsAi,
    });
  }
  for (const u of plan.unscheduled) {
    const existing = byTask.get(u.id);
    byTask.set(u.id, {
      id: u.id,
      title: u.title,
      remainingMinutes: (existing?.remainingMinutes ?? 0) + u.remainingMinutes,
      priority: u.priority,
      dueAt: u.dueAt,
      origin: u.origin,
      sourceRef: u.sourceRef,
    });
  }
  return [...byTask.values()];
}

function minutesBetween(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return eh * 60 + em - (sh * 60 + sm);
}

export function executePlanningToolCall(args: {
  call: { id: string; function: { name: string; arguments: string } };
  controller: DataController;
  conversationId: string;
  assistantMessageId: string;
  canvasScope: ActiveCanvasScope | null;
  canvasProvenance: CanvasProvenance | null;
  now?: Date;
}): PlanningToolOutcome {
  const now = args.now ?? new Date();
  const name = args.call.function.name.trim();
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(args.call.function.arguments || "{}");
  } catch {
    return deny(args.call.id, "planning_clarify", "Planning", "Ongeldige JSON-argumenten.");
  }

  const data = args.controller.getSnapshot().data;
  if (!data) {
    return deny(args.call.id, "planning_clarify", "Planning", "Gegevens zijn nog niet geladen.");
  }

  if (name === "planning_ask_clarification") {
    const check = clarifySchema.safeParse(parsedJson);
    if (!check.success) {
      return deny(args.call.id, "planning_clarify", "Verduidelijking", "Ongeldige verduidelijkingsvraag.");
    }
    return {
      toolCallId: args.call.id,
      content: JSON.stringify({
        status: "success",
        action: "ask_user",
        question: check.data.question,
        note: "Stel deze vraag letterlijk aan de student en maak nog geen planning.",
      }),
      step: {
        id: args.call.id,
        operation: "planning_clarify",
        label: "Verduidelijking gevraagd",
        status: "success",
        detail: check.data.question.slice(0, 120),
        courseIds: [],
        categories: [],
      },
    };
  }

  if (name === "planning_create_plan") {
    const check = createSchema.safeParse(parsedJson);
    if (!check.success) {
      return deny(
        args.call.id,
        "plan_create",
        "Planning maken",
        check.error.issues[0]?.message ?? "Ongeldige planning-argumenten.",
      );
    }
    const input = check.data;
    if (!isValidYmd(input.start_date)) {
      return deny(args.call.id, "plan_create", "Planning maken", "start_date moet YYYY-MM-DD zijn.");
    }

    const tasks = input.tasks.map(toProposed);
    for (const t of tasks) {
      if (t.origin === "canvas" && !t.dueAt && !t.sourceRef) {
        // Canvas tasks without due are allowed (undated) but must not invent due_at — already null.
      }
      if (t.origin === "canvas" && t.estimateIsAi && !t.dueAt) {
        // ok
      }
    }

    const busy: BusyBlock[] = (input.busy ?? []).filter((b) => isValidYmd(b.date));
    const startDate =
      input.scope === "week" ? mondayOfAmsterdamWeek(input.start_date) : input.start_date;

    const allocated = allocatePlan({
      profile: data.profile,
      scope: input.scope,
      startDate,
      now,
      tasks,
      busy,
      exceptions: data.profile.dateExceptions,
      includeCompleted: input.include_completed,
    });

    const draftPlan: Plan = {
      id: newId(),
      title: input.title?.trim() || (input.scope === "dag" ? "Dagplanning" : "Weekplanning"),
      scope: input.scope,
      startDate,
      conversationId: args.conversationId,
      messageId: args.assistantMessageId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      blocks: allocated.blocks.map((b) => ({
        id: b.id,
        date: b.date,
        start: b.start,
        end: b.end,
        title: b.title,
        priority: b.priority,
        origin: b.origin,
        sourceRef: b.sourceRef,
        taskId: b.taskId,
        dueAt: b.dueAt,
        isBreak: b.isBreak,
        estimateIsAi: b.estimateIsAi,
      })),
      status: allocated.status,
      revision: 1,
      supersedesPlanId: null,
      assumptions: input.assumptions ?? [],
      warnings: [...(input.warnings ?? []), ...allocated.warnings],
      unscheduled: allocated.unscheduled,
      capacityShortfallMinutes: allocated.capacityShortfallMinutes,
      oneOffConstraints: [],
      canvasProvenance: args.canvasProvenance ?? undefined,
      testStudentCourseIds: args.canvasProvenance?.testStudentCourseIds,
    };

    const issues = validateAllocatedPlan({
      plan: draftPlan,
      profile: data.profile,
      now,
      busy,
      exceptions: data.profile.dateExceptions,
    });
    if (issues.length > 0) {
      return {
        toolCallId: args.call.id,
        content: JSON.stringify({
          status: "failed",
          error: "Planning niet opgeslagen: validatie mislukt.",
          issues: issues.map((i) => i.message),
        }),
        step: {
          id: args.call.id,
          operation: "plan_create",
          label: "Planning geweigerd (validatie)",
          status: "failed",
          detail: issues[0]?.message,
          courseIds: [],
          categories: [],
        },
      };
    }

    persistPlan(args.controller, args.conversationId, draftPlan, args.assistantMessageId);
    const md = formatPlanMarkdown(draftPlan);
    return {
      toolCallId: args.call.id,
      content: JSON.stringify({
        status: allocated.status === "partial" ? "partial" : "success",
        plan_id: draftPlan.id,
        revision: draftPlan.revision,
        capacity_shortfall_minutes: draftPlan.capacityShortfallMinutes,
        markdown_table: md,
        note: "Toon de markdown_table aan de student. Verschuif geen deadlines of uren.",
      }),
      step: {
        id: args.call.id,
        operation: "plan_create",
        label: allocated.status === "partial" ? "Gedeeltelijke planning opgeslagen" : "Planning opgeslagen",
        status: allocated.status === "partial" ? "partial" : "success",
        detail: `${draftPlan.blocks.filter((b) => !b.isBreak).length} blokken`,
        courseIds: args.canvasProvenance?.courseIds ?? [],
        categories: args.canvasProvenance?.categories ?? [],
      },
      planId: draftPlan.id,
      savedPlan: draftPlan,
    };
  }

  if (name === "planning_revise_plan") {
    const check = reviseSchema.safeParse(parsedJson);
    if (!check.success) {
      return deny(args.call.id, "plan_revise", "Planning herzien", "Ongeldige revisie-argumenten.");
    }
    const input = check.data;
    const conv = data.conversations.find((c) => c.id === args.conversationId);
    const planId = input.plan_id || conv?.activePlanId;
    if (!planId) {
      return deny(args.call.id, "plan_revise", "Planning herzien", "Geen actieve planning in dit gesprek.");
    }
    const previous = data.plans.find((p) => p.id === planId);
    if (!previous) {
      return deny(args.call.id, "plan_revise", "Planning herzien", "Planning niet gevonden.");
    }
    if (args.canvasScope && !isPlanAllowed(previous, args.canvasScope)) {
      return deny(
        args.call.id,
        "plan_revise",
        "Planning herzien",
        "Deze planning is niet meer toegestaan onder de huidige Canvas-toestemmingen of testmodus.",
      );
    }

    let tasks = tasksFromExistingPlan(previous);
    if (input.reduce_load_note) {
      tasks = tasks.map((t) =>
        t.estimateIsAi || t.origin === "ai-schatting"
          ? { ...t, remainingMinutes: Math.max(15, Math.round(t.remainingMinutes * 0.75)) }
          : t,
      );
    }
    for (const t of input.extra_tasks ?? []) tasks.push(toProposed(t));

    const unavailable = [
      ...previous.oneOffConstraints.filter((c) => c.type === "date_unavailable" && c.date).map((c) => c.date!),
      ...(input.unavailable_dates ?? []).filter(isValidYmd),
    ];

    const allocated = allocatePlan({
      profile: data.profile,
      scope: previous.scope,
      startDate: previous.startDate,
      now,
      tasks,
      exceptions: data.profile.dateExceptions,
      oneOffUnavailableDates: unavailable,
    });

    const oneOff = [
      ...previous.oneOffConstraints,
      ...(input.unavailable_dates ?? []).filter(isValidYmd).map((date) => ({
        id: newId(),
        type: "date_unavailable" as const,
        date,
        note: `Kan even niet op ${date}`,
      })),
    ];
    if (input.reduce_load_note) {
      oneOff.push({
        id: newId(),
        type: "reduce_load",
        note: input.reduce_load_note,
      });
    }

    const draftPlan: Plan = {
      ...previous,
      id: newId(),
      revision: previous.revision + 1,
      supersedesPlanId: previous.id,
      messageId: args.assistantMessageId,
      updatedAt: now.toISOString(),
      createdAt: now.toISOString(),
      blocks: allocated.blocks.map((b) => ({
        id: b.id,
        date: b.date,
        start: b.start,
        end: b.end,
        title: b.title,
        priority: b.priority,
        origin: b.origin,
        sourceRef: b.sourceRef,
        taskId: b.taskId,
        dueAt: b.dueAt,
        isBreak: b.isBreak,
        estimateIsAi: b.estimateIsAi,
      })),
      status: allocated.status,
      assumptions: [...previous.assumptions, ...(input.assumptions ?? [])],
      warnings: [...previous.warnings, ...(input.warnings ?? []), ...allocated.warnings],
      unscheduled: allocated.unscheduled,
      capacityShortfallMinutes: allocated.capacityShortfallMinutes,
      oneOffConstraints: oneOff,
      canvasProvenance: args.canvasProvenance ?? previous.canvasProvenance,
      testStudentCourseIds:
        args.canvasProvenance?.testStudentCourseIds ?? previous.testStudentCourseIds,
    };

    const issues = validateAllocatedPlan({
      plan: draftPlan,
      profile: data.profile,
      now,
      exceptions: data.profile.dateExceptions,
    });
    if (issues.length > 0) {
      return {
        toolCallId: args.call.id,
        content: JSON.stringify({
          status: "failed",
          error: "Revisie niet opgeslagen: validatie mislukt.",
          issues: issues.map((i) => i.message),
        }),
        step: {
          id: args.call.id,
          operation: "plan_revise",
          label: "Revisie geweigerd (validatie)",
          status: "failed",
          detail: issues[0]?.message,
          courseIds: [],
          categories: [],
        },
      };
    }

    persistPlan(args.controller, args.conversationId, draftPlan, args.assistantMessageId);
    const md = formatPlanMarkdown(draftPlan);
    return {
      toolCallId: args.call.id,
      content: JSON.stringify({
        status: allocated.status === "partial" ? "partial" : "success",
        plan_id: draftPlan.id,
        revision: draftPlan.revision,
        supersedes_plan_id: previous.id,
        markdown_table: md,
        note: "Toon de bijgewerkte markdown_table. Oude chattabellen blijven staan; dit is versie " + draftPlan.revision + ".",
      }),
      step: {
        id: args.call.id,
        operation: "plan_revise",
        label: `Planning versie ${draftPlan.revision} opgeslagen`,
        status: allocated.status === "partial" ? "partial" : "success",
        detail: `${draftPlan.blocks.filter((b) => !b.isBreak).length} blokken`,
        courseIds: [],
        categories: [],
      },
      planId: draftPlan.id,
      savedPlan: draftPlan,
    };
  }

  return deny(args.call.id, "planning_clarify", "Planning", `Onbekende planningstool: ${name}`);
}

/** Active plan for conversation if still permitted under scope. */
export function getActivePlanForContext(
  data: AppData,
  conversationId: string,
  scope: ActiveCanvasScope | null,
): Plan | null {
  const conv = data.conversations.find((c) => c.id === conversationId);
  if (!conv?.activePlanId) return null;
  const plan = data.plans.find((p) => p.id === conv.activePlanId);
  if (!plan) return null;
  if (scope && !isPlanAllowed(plan, scope)) return null;
  return plan;
}
