import { addUserMessage, newId, titleFrom } from "../conversations";
import type { DataController } from "../dataController";
import type { CanvasService } from "../mcp/canvasService";
import { type ActiveCanvasScope, isProvenanceAllowed } from "../mcp/provenance";
import { OPERATION_CATEGORY, OPERATION_LABELS } from "../mcp/types";
import type { Platform } from "../platform";
import type {
  AppData,
  CanvasCategory,
  CanvasProvenance,
  CanvasSourceRef,
  Message,
  ToolStep,
} from "../schema";
import { AiError, type ChatMessageParam, redactSecrets, streamChatCompletion } from "./client";
import { buildChatMessages } from "./context";
import { chatCompletionsUrl } from "./endpoint";
import {
  buildPlanningTools,
  executePlanningToolCall,
  isPlanningToolName,
} from "../planning/tools";
import {
  AI_TOOL_NAME_TO_OPERATION,
  buildAdvertisedTools,
  executeCanvasToolCall,
} from "./tools";

export interface ActiveReplyState {
  conversationId: string;
  messageId: string;
  text: string;
  toolSteps: ToolStep[];
  sources: CanvasSourceRef[];
  planId?: string;
}

type Listener = () => void;

const DEFAULT_FLUSH_INTERVAL_MS = 120;
const CONTINUATION_PROMPT =
  "[PLuMS] Geef nu je eindantwoord aan de student in het Nederlands, uitsluitend op basis van de Canvas-gegevens hierboven. Roep geen functies meer aan.";
/** Soft safety only (hung runs / Stop); no artificial per-turn Canvas call or round caps. */
const MAX_TOTAL_RUN_MS = 15 * 60_000;

interface RunTracking {
  controller: AbortController;
  initialScope: ActiveCanvasScope | null;
  usedCategories: Set<CanvasCategory>;
  usedCourseIds: Set<string>;
  usedSourceIds: Set<string>;
  usedTestStudentCourseIds: Set<string>;
  abortedByScopeChange: boolean;
}

/**
 * Coordinates streaming AI replies and bounded Canvas MCP tool calls across conversations.
 * Concurrency is keyed by `conversationId`; global Stop (`stopAll`) or permission/account changes
 * cancel affected active runs immediately and persist whatever state is safe.
 */
export class ChatRunner {
  private readonly active = new Map<string, ActiveReplyState>();
  private readonly tracking = new Map<string, RunTracking>();
  private readonly listeners = new Set<Listener>();
  private runningSet: ReadonlySet<string> = new Set();

  constructor(
    private readonly platform: Platform,
    private readonly controller: DataController,
    private readonly now: () => Date = () => new Date(),
    private readonly flushIntervalMs: number = DEFAULT_FLUSH_INTERVAL_MS,
    private readonly canvasService?: CanvasService,
  ) {
    this.controller.subscribe(() => {
      this.checkActiveRunsAgainstScope();
    });
    this.canvasService?.subscribe(() => {
      this.checkActiveRunsAgainstScope();
    });
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Returns the immutable set of conversation IDs currently running (for `useSyncExternalStore`). */
  getSnapshot = (): ReadonlySet<string> => this.runningSet;

  private updateRunningSet(): void {
    const next = new Set(this.tracking.keys());
    if (
      next.size === this.runningSet.size &&
      [...next].every((id) => this.runningSet.has(id))
    ) {
      return;
    }
    this.runningSet = next;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  isRunning(conversationId: string): boolean {
    return this.tracking.has(conversationId);
  }

  getActiveReply(conversationId: string): ActiveReplyState | undefined {
    return this.active.get(conversationId);
  }

  stop(conversationId: string): void {
    this.tracking.get(conversationId)?.controller.abort();
  }

  cancel(conversationId: string): void {
    this.tracking.get(conversationId)?.controller.abort();
  }

  cancelAll(): void {
    this.stopAll();
  }

  stopAll(): void {
    for (const run of this.tracking.values()) {
      run.controller.abort();
    }
    this.canvasService?.cancelAllInFlight();
  }

  /**
   * Immediately cancels any active run whose connection/account scope changed,
   * or whose already-used categories/courses were disabled/deselected during the run.
   */
  private checkActiveRunsAgainstScope(): void {
    if (!this.canvasService || this.tracking.size === 0) return;
    const currentScope = this.canvasService.getActiveScope();

    for (const run of this.tracking.values()) {
      if (!run.initialScope || !currentScope) continue;

      const connectionChanged = run.initialScope.scopeId !== currentScope.scopeId;
      let permissionRevoked = false;

      for (const cat of run.usedCategories) {
        if (!currentScope.enabledCategories[cat]) {
          permissionRevoked = true;
          break;
        }
      }
      if (!permissionRevoked) {
        for (const courseId of run.usedCourseIds) {
          if (!currentScope.selectedCourseIds.has(courseId)) {
            permissionRevoked = true;
            break;
          }
        }
      }
      if (!permissionRevoked) {
        for (const courseId of run.usedTestStudentCourseIds) {
          if (!currentScope.testStudentCourseIds.has(courseId)) {
            permissionRevoked = true;
            break;
          }
        }
      }

      if (connectionChanged || permissionRevoked) {
        run.abortedByScopeChange = true;
        run.controller.abort();
      }
    }
  }

  /**
   * Appends a user message (creating the conversation if needed) and starts streaming the assistant reply.
   * Returns the conversation ID synchronously so the UI can select it immediately.
   */
  send(conversationId: string | null, rawContent: string): string | null {
    const content = rawContent.trim();
    if (!content) return null;
    if (conversationId && this.isRunning(conversationId)) return conversationId;

    const assistantMessageId = newId();
    const timestamp = this.now().toISOString();
    let targetConvId = conversationId;

    this.controller.update((draft) => {
      targetConvId = addUserMessage(draft, conversationId, content);
      const conv = draft.conversations.find((c) => c.id === targetConvId);
      if (conv) {
        conv.messages.push({
          id: assistantMessageId,
          role: "assistant",
          content: "",
          createdAt: timestamp,
          status: "streaming",
        });
        conv.updatedAt = timestamp;
      }
    });

    if (!targetConvId) return null;
    void this.runStream(targetConvId, assistantMessageId, new Set([assistantMessageId]));
    return targetConvId;
  }

  /**
   * Regenerates a specific assistant reply (or the latest assistant reply when `assistantMessageId` is omitted)
   * without duplicating the user turn, leaking previous tool results, or allowing overlapping runs.
   */
  retry(conversationId: string, assistantMessageId?: string): void {
    if (this.isRunning(conversationId)) return;
    const data = this.controller.getSnapshot().data;
    const conv = data?.conversations.find((c) => c.id === conversationId);
    if (!conv || conv.messages.length === 0) return;

    const timestamp = this.now().toISOString();
    let targetAssistantId: string | undefined;
    const excludeIds = new Set<string>();

    if (assistantMessageId) {
      const idx = conv.messages.findIndex(
        (m) => m.id === assistantMessageId && m.role === "assistant",
      );
      if (idx === -1) return;
      targetAssistantId = assistantMessageId;
      // Exclude the target assistant message and any subsequent messages so the regeneration uses
      // only the conversation history up to the preceding user turn.
      for (let i = idx; i < conv.messages.length; i++) {
        excludeIds.add(conv.messages[i].id);
      }
      this.controller.update((draft) => {
        const c = draft.conversations.find((x) => x.id === conversationId);
        const msg = c?.messages.find((m) => m.id === targetAssistantId);
        if (c && msg) {
          msg.content = "";
          msg.status = "streaming";
          delete msg.error;
          delete msg.canvasProvenance;
          delete msg.sources;
          delete msg.toolSteps;
          c.updatedAt = timestamp;
        }
      });
    } else {
      const last = conv.messages[conv.messages.length - 1];
      if (last.role === "assistant") {
        targetAssistantId = last.id;
        excludeIds.add(targetAssistantId);
        this.controller.update((draft) => {
          const c = draft.conversations.find((x) => x.id === conversationId);
          const msg = c?.messages.find((m) => m.id === targetAssistantId);
          if (c && msg) {
            msg.content = "";
            msg.status = "streaming";
            delete msg.error;
            delete msg.canvasProvenance;
            delete msg.sources;
            delete msg.toolSteps;
            c.updatedAt = timestamp;
          }
        });
      } else {
        targetAssistantId = newId();
        excludeIds.add(targetAssistantId);
        this.controller.update((draft) => {
          const c = draft.conversations.find((x) => x.id === conversationId);
          if (c) {
            c.messages.push({
              id: targetAssistantId!,
              role: "assistant",
              content: "",
              createdAt: timestamp,
              status: "streaming",
            });
            c.updatedAt = timestamp;
          }
        });
      }
    }

    if (!targetAssistantId) return;
    void this.runStream(conversationId, targetAssistantId, excludeIds);
  }

  /**
   * Updates the latest user message in a conversation and regenerates the affected assistant reply
   * with current source permissions and clean activity/provenance.
   */
  editLatestUserMessage(
    conversationId: string,
    userMessageId: string,
    rawContent: string,
  ): boolean {
    const content = rawContent.trim();
    if (!content) return false;
    if (this.isRunning(conversationId)) return false;

    const data = this.controller.getSnapshot().data;
    const conv = data?.conversations.find((c) => c.id === conversationId);
    if (!conv || conv.messages.length === 0) return false;

    // Locate the latest user message and verify it matches `userMessageId`
    let latestUserIdx = -1;
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      if (conv.messages[i].role === "user") {
        latestUserIdx = i;
        break;
      }
    }
    if (latestUserIdx === -1 || conv.messages[latestUserIdx].id !== userMessageId) {
      return false;
    }

    const timestamp = this.now().toISOString();
    const existingAssistant = conv.messages[latestUserIdx + 1];
    const assistantMessageId =
      existingAssistant && existingAssistant.role === "assistant"
        ? existingAssistant.id
        : newId();

    this.controller.update((draft) => {
      const c = draft.conversations.find((x) => x.id === conversationId);
      if (!c) return;
      const uIdx = c.messages.findIndex((m) => m.id === userMessageId && m.role === "user");
      if (uIdx === -1) return;

      c.messages[uIdx].content = content;
      if (uIdx === 0) {
        c.title = titleFrom(content);
      }

      // Truncate any messages after the edited user message and replace with a clean streaming assistant turn
      c.messages.splice(uIdx + 1);
      c.messages.push({
        id: assistantMessageId,
        role: "assistant",
        content: "",
        createdAt: timestamp,
        status: "streaming",
      });
      c.updatedAt = timestamp;
    });

    void this.runStream(conversationId, assistantMessageId, new Set([assistantMessageId]));
    return true;
  }

  private mutateMessage(
    conversationId: string,
    messageId: string,
    patch: {
      content?: string;
      status?: Message["status"];
      error?: string | null;
      toolSteps?: ToolStep[] | null;
      sources?: CanvasSourceRef[] | null;
      canvasProvenance?: CanvasProvenance | null;
      planId?: string | null;
    },
    immediate = false,
  ): void {
    const snap = this.controller.getSnapshot();
    if (snap.load.status !== "ready" || !snap.data) return;
    const exists = snap.data.conversations
      .find((c) => c.id === conversationId)
      ?.messages.some((m) => m.id === messageId);
    if (!exists) return;

    this.controller.update(
      (draft: AppData) => {
        const conv = draft.conversations.find((c) => c.id === conversationId);
        const msg = conv?.messages.find((m) => m.id === messageId);
        if (!conv || !msg) return;
        if (patch.content !== undefined) msg.content = patch.content;
        if (patch.status !== undefined) msg.status = patch.status;
        if (patch.error !== undefined) {
          if (patch.error === null) delete msg.error;
          else msg.error = patch.error;
        }
        if (patch.toolSteps !== undefined) {
          if (patch.toolSteps === null) delete msg.toolSteps;
          else msg.toolSteps = patch.toolSteps;
        }
        if (patch.sources !== undefined) {
          if (patch.sources === null) delete msg.sources;
          else msg.sources = patch.sources;
        }
        if (patch.canvasProvenance !== undefined) {
          if (patch.canvasProvenance === null) delete msg.canvasProvenance;
          else msg.canvasProvenance = patch.canvasProvenance;
        }
        if (patch.planId !== undefined) {
          if (patch.planId === null) delete msg.planId;
          else msg.planId = patch.planId;
        }
        conv.updatedAt = this.now().toISOString();
      },
      { immediate },
    );
  }

  private async runStream(
    conversationId: string,
    assistantMessageId: string,
    excludeIds: ReadonlySet<string>,
  ): Promise<void> {
    const abortController = new AbortController();
    const initialScope = this.canvasService?.getActiveScope() ?? null;
    const runTrack: RunTracking = {
      controller: abortController,
      initialScope,
      usedCategories: new Set(),
      usedCourseIds: new Set(),
      usedSourceIds: new Set(),
      usedTestStudentCourseIds: new Set(),
      abortedByScopeChange: false,
    };

    const runTimer = setTimeout(() => {
      abortController.abort();
    }, MAX_TOTAL_RUN_MS);

    this.tracking.set(conversationId, runTrack);
    this.active.set(conversationId, {
      conversationId,
      messageId: assistantMessageId,
      text: "",
      toolSteps: [],
      sources: [],
    });
    this.updateRunningSet();

    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let lastFlushedText = "";
    let lastFlushedStepsJson = "[]";

    const currentProvenance = (): CanvasProvenance | null => {
      if (
        !runTrack.initialScope ||
        (runTrack.usedCategories.size === 0 &&
          runTrack.usedCourseIds.size === 0 &&
          runTrack.usedSourceIds.size === 0)
      ) {
        return null;
      }
      return {
        scopeId: runTrack.initialScope.scopeId,
        categories: [...runTrack.usedCategories],
        courseIds: [...runTrack.usedCourseIds],
        sourceIds: [...runTrack.usedSourceIds],
        ...(runTrack.usedTestStudentCourseIds.size > 0
          ? { testStudentCourseIds: [...runTrack.usedTestStudentCourseIds] }
          : {}),
      };
    };

    const flushDraft = (force = false) => {
      const current = this.active.get(conversationId);
      if (!current) return;
      const stepsJson = JSON.stringify(current.toolSteps);
      if (!force && current.text === lastFlushedText && stepsJson === lastFlushedStepsJson) return;
      lastFlushedText = current.text;
      lastFlushedStepsJson = stepsJson;
      this.mutateMessage(conversationId, assistantMessageId, {
        content: current.text,
        status: "streaming",
        toolSteps: current.toolSteps.length > 0 ? [...current.toolSteps] : null,
        sources: current.sources.length > 0 ? [...current.sources] : null,
        canvasProvenance: currentProvenance(),
      });
    };

    const scheduleFlush = () => {
      if (this.flushIntervalMs <= 0) {
        flushDraft(true);
        return;
      }
      if (flushTimer !== null) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushDraft();
      }, this.flushIntervalMs);
    };

    try {
      const data = this.controller.getSnapshot().data;
      const conv = data?.conversations.find((c) => c.id === conversationId);
      if (!data || !conv) throw new AiError("config", "Gesprek niet gevonden.");

      const urlCheck = chatCompletionsUrl(data.settings.ai.baseUrl);
      if (!urlCheck.ok) throw new AiError("config", urlCheck.error);
      const model = data.settings.ai.model.trim();
      if (!model) {
        throw new AiError(
          "config",
          "Geen AI-model ingesteld. Vul een modelnaam in bij Instellingen → AI.",
        );
      }

      const completionsUrl = urlCheck.url;
      const hasKey = await this.platform.secrets.has(completionsUrl);
      if (!hasKey) {
        throw new AiError(
          "missing-key",
          "Geen AI-toegangssleutel gevonden voor deze server. Sla je sleutel op bij Instellingen → AI.",
        );
      }

      const advertisedOps = this.canvasService
        ? await this.canvasService.getAdvertisableOperations(abortController.signal)
        : [];
      const activeScope = this.canvasService?.getActiveScope() ?? undefined;
      runTrack.initialScope = activeScope ?? null;

      const courseNames = new Map<string, string>();
      if (this.canvasService) {
        for (const c of this.canvasService.getSnapshot().availableCourses) {
          courseNames.set(c.id, c.name);
        }
        for (const id of data.settings.canvas.selectedCourseIds) {
          const name = this.canvasService.getCourseName(id);
          if (name) courseNames.set(id, name);
        }
      }

      const latestDataAtStart = this.controller.getSnapshot().data ?? data;
      const latestConvAtStart =
        latestDataAtStart.conversations.find((c) => c.id === conversationId) ?? conv;

      // Inherit provenance from any permitted Canvas-derived assistant messages in the conversation
      // that are included in the prompt context, so follow-up assistant replies remain tagged as
      // derived from those Canvas sources/categories/courses!
      for (const m of latestConvAtStart.messages) {
        if (
          !excludeIds.has(m.id) &&
          m.content.trim().length > 0 &&
          m.status !== "failed" &&
          m.status !== "streaming" &&
          m.canvasProvenance &&
          activeScope &&
          isProvenanceAllowed(m.canvasProvenance, activeScope)
        ) {
          for (const cat of m.canvasProvenance.categories) runTrack.usedCategories.add(cat);
          for (const cId of m.canvasProvenance.courseIds) runTrack.usedCourseIds.add(cId);
          for (const sId of m.canvasProvenance.sourceIds) runTrack.usedSourceIds.add(sId);
          for (const tId of m.canvasProvenance.testStudentCourseIds ?? []) {
            runTrack.usedTestStudentCourseIds.add(tId);
          }
        }
      }

      const messages: ChatMessageParam[] = buildChatMessages(
        latestDataAtStart,
        latestConvAtStart,
        excludeIds,
        {
          canvasScope: activeScope,
          advertisedOperations: advertisedOps,
          courseNames,
        },
      );

      let totalToolCalls = 0;
      let lastFinishReason: string | null = null;
      let usedContinuation = false;
      const appendText = (delta: string) => {
        const state = this.active.get(conversationId);
        if (!state) return;
        state.text += delta;
        this.emit();
        scheduleFlush();
      };

      for (;;) {
        if (abortController.signal.aborted) {
          throw new AiError("aborted", "Gestopt.");
        }
        const latestData = this.controller.getSnapshot().data ?? latestDataAtStart;
        const selectedCourseIds = latestData.settings.canvas.selectedCourseIds;
        const roundOps = this.canvasService
          ? await this.canvasService.getAdvertisableOperations(abortController.signal)
          : [];
        const canvasTools =
          this.canvasService && roundOps.length > 0
            ? buildAdvertisedTools(roundOps, selectedCourseIds)
            : [];
        const tools = [...canvasTools, ...buildPlanningTools()];

        const roundStartText = this.active.get(conversationId)?.text ?? "";

        const streamRes = await streamChatCompletion({
          transport: this.platform.http,
          url: completionsUrl,
          model,
          messages,
          tools,
          signal: abortController.signal,
          onText: appendText,
        });
        lastFinishReason = streamRes.finishReason;

        if (streamRes.toolCalls.length === 0) {
          // Some models (e.g. Claude) may validly end the turn with empty content right after tool results.
          // Recover once with a separate continuation message; never resend the identical request.
          const state = this.active.get(conversationId);
          if (totalToolCalls > 0 && state && !state.text.trim()) {
            usedContinuation = true;
            const continuation = await streamChatCompletion({
              transport: this.platform.http,
              url: completionsUrl,
              model,
              messages: [...messages, { role: "user", content: CONTINUATION_PROMPT }],
              signal: abortController.signal,
              onText: appendText,
            });
            lastFinishReason = continuation.finishReason;
          }
          break;
        }

        if (!this.canvasService) {
          break;
        }

        const stateAfterModel = this.active.get(conversationId);
        if (
          stateAfterModel &&
          stateAfterModel.text.length > roundStartText.length &&
          !stateAfterModel.text.endsWith("\n\n")
        ) {
          stateAfterModel.text += "\n\n";
        }

        messages.push({
          role: "assistant",
          content: streamRes.text || null,
          tool_calls: streamRes.toolCalls,
        });

        for (let i = 0; i < streamRes.toolCalls.length; i++) {
          const call = streamRes.toolCalls[i];
          totalToolCalls += 1;
          const rawToolName = call.function.name.trim();

          if (isPlanningToolName(rawToolName)) {
            const runningStep: ToolStep = {
              id: call.id,
              operation:
                rawToolName === "planning_create_plan"
                  ? "plan_create"
                  : rawToolName === "planning_revise_plan"
                    ? "plan_revise"
                    : "planning_clarify",
              label: "Planning…",
              status: "running",
              detail: "Lokale planning valideren…",
              courseIds: [],
              categories: [],
            };
            const stateBeforeCall = this.active.get(conversationId);
            if (stateBeforeCall) {
              stateBeforeCall.toolSteps = [...stateBeforeCall.toolSteps, runningStep];
              this.emit();
              scheduleFlush();
            }

            const planOutcome = executePlanningToolCall({
              call,
              controller: this.controller,
              conversationId,
              assistantMessageId,
              canvasScope: this.canvasService?.getActiveScope() ?? null,
              canvasProvenance: currentProvenance(),
              now: this.now(),
            });

            const stateAfterCall = this.active.get(conversationId);
            if (stateAfterCall) {
              stateAfterCall.toolSteps = stateAfterCall.toolSteps.map((s) =>
                s.id === call.id ? planOutcome.step : s,
              );
              if (planOutcome.planId) {
                stateAfterCall.planId = planOutcome.planId;
                this.mutateMessage(conversationId, assistantMessageId, {
                  planId: planOutcome.planId,
                });
              }
              this.emit();
              scheduleFlush();
            }

            if (abortController.signal.aborted) {
              throw new AiError("aborted", "Gestopt.");
            }

            messages.push({
              role: "tool",
              tool_call_id: planOutcome.toolCallId,
              content: planOutcome.content,
            });
            continue;
          }

          const mappedOp = Object.prototype.hasOwnProperty.call(
            AI_TOOL_NAME_TO_OPERATION,
            rawToolName,
          )
            ? AI_TOOL_NAME_TO_OPERATION[rawToolName]
            : undefined;

          const op = mappedOp ?? "courses";
          const cat = mappedOp ? OPERATION_CATEGORY[mappedOp] : null;
          const latestSnap = this.controller.getSnapshot().data;
          if (cat && latestSnap?.settings.canvas.categories[cat]) {
            runTrack.usedCategories.add(cat);
          }

          const runningStep: ToolStep = {
            id: call.id,
            operation: op,
            label: mappedOp ? OPERATION_LABELS[mappedOp] : `Onbekende tool (${rawToolName})`,
            status: "running",
            detail: "Even kijken…",
            courseIds: [],
            categories: cat ? [cat] : [],
          };

          const stateBeforeCall = this.active.get(conversationId);
          if (stateBeforeCall) {
            stateBeforeCall.toolSteps = [...stateBeforeCall.toolSteps, runningStep];
            this.emit();
            scheduleFlush();
          }

          const freshData = this.controller.getSnapshot().data;
          const freshSelectedCourses = freshData?.settings.canvas.selectedCourseIds ?? [];

          const outcome = await executeCanvasToolCall(
            call,
            this.canvasService,
            freshSelectedCourses,
            abortController.signal,
          );

          for (const cId of outcome.courseIds) runTrack.usedCourseIds.add(cId);
          if (outcome.step.status !== "denied") {
            for (const cCat of outcome.categories) runTrack.usedCategories.add(cCat);
          }
          for (const src of outcome.sources) runTrack.usedSourceIds.add(src.id);
          for (const tId of outcome.testStudentCourseIds ?? []) runTrack.usedTestStudentCourseIds.add(tId);

          const stateAfterCall = this.active.get(conversationId);
          if (stateAfterCall) {
            stateAfterCall.toolSteps = stateAfterCall.toolSteps.map((s) =>
              s.id === call.id ? outcome.step : s,
            );
            const existingIds = new Set(stateAfterCall.sources.map((s) => s.id));
            for (const src of outcome.sources) {
              if (!existingIds.has(src.id)) {
                stateAfterCall.sources.push(src);
                existingIds.add(src.id);
              }
            }
            this.emit();
            scheduleFlush();
          }

          if (abortController.signal.aborted) {
            throw new AiError("aborted", "Gestopt.");
          }

          messages.push({
            role: "tool",
            tool_call_id: outcome.toolCallId,
            content: outcome.content,
          });
        }
      }

      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }

      const finalState = this.active.get(conversationId);
      const finalText = finalState?.text.trim() ?? "";
      const finalSteps = finalState?.toolSteps ?? [];
      const finalSources = finalState?.sources ?? [];
      const provenance = currentProvenance();

      // Verify provenance is still allowed before saving final answer
      const endScope = this.canvasService?.getActiveScope();
      if (provenance && endScope && !isProvenanceAllowed(provenance, endScope)) {
        runTrack.abortedByScopeChange = true;
        throw new AiError("aborted", "Gestopt wegens gewijzigde Canvas-toestemmingen.");
      }

      if (!finalText) {
        const reason = lastFinishReason ? ` (finish_reason: ${lastFinishReason})` : "";
        const afterTools =
          totalToolCalls > 0
            ? ` na ${totalToolCalls} Canvas-aanroep(en)${usedContinuation ? ", ook na een vervolgverzoek" : ""}`
            : "";
        throw new AiError(
          "bad-response",
          `De AI-dienst stuurde een leeg antwoord terug${afterTools}${reason}. Probeer het antwoord opnieuw te genereren.`,
        );
      }

      this.mutateMessage(
        conversationId,
        assistantMessageId,
        {
          content: finalState?.text ?? finalText,
          status: "completed",
          error: null,
          toolSteps: finalSteps.length > 0 ? finalSteps : null,
          sources: finalSources.length > 0 ? finalSources : null,
          canvasProvenance: provenance,
          planId: finalState?.planId ?? null,
        },
        true,
      );
    } catch (error) {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      const state = this.active.get(conversationId);
      const partial = state?.text ?? "";
      const partialSteps = (state?.toolSteps ?? []).map((s) =>
        s.status === "running" ? { ...s, status: "cancelled" as const, detail: "Afgebroken" } : s,
      );
      const partialSources = state?.sources ?? [];
      const provenance = currentProvenance();

      const isAborted =
        abortController.signal.aborted ||
        (error instanceof AiError && error.kind === "aborted");

      if (isAborted) {
        const stopReason = runTrack.abortedByScopeChange
          ? "Antwoord gestopt omdat de Canvas-toestemmingen, cursusselectie of verbinding tijdens het uitvoeren zijn gewijzigd."
          : "Antwoord gestopt door gebruiker.";
        this.mutateMessage(
          conversationId,
          assistantMessageId,
          {
            content: partial,
            status: "stopped",
            error: stopReason,
            toolSteps: partialSteps.length > 0 ? partialSteps : null,
            sources: !runTrack.abortedByScopeChange && partialSources.length > 0 ? partialSources : null,
            canvasProvenance: provenance,
          },
          true,
        );
      } else {
        const safeMsg = redactSecrets(
          error instanceof AiError
            ? error.message
            : error instanceof Error
              ? `Er ging iets mis: ${error.message}`
              : "Onbekende fout bij het genereren van het antwoord.",
        );
        this.mutateMessage(
          conversationId,
          assistantMessageId,
          {
            content: partial,
            status: "failed",
            error: safeMsg,
            toolSteps: partialSteps.length > 0 ? partialSteps : null,
            sources: partialSources.length > 0 ? partialSources : null,
            canvasProvenance: provenance,
          },
          true,
        );
      }
    } finally {
      clearTimeout(runTimer);
      this.tracking.delete(conversationId);
      this.active.delete(conversationId);
      this.updateRunningSet();
      this.emit();
    }
  }
}

export function isMessageActionable(msg: Message): boolean {
  return msg.role === "assistant" && (msg.status === "failed" || msg.status === "stopped");
}
