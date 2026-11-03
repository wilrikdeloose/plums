import type { DataController } from "../dataController";
import type { SecretStore } from "../platform";
import type { CanvasCategory } from "../schema";
import {
  normalizeAnnouncementsPayload,
  normalizeAssignmentsPayload,
  normalizeCalendarEventsPayload,
  normalizeCoursesPayload,
  normalizeModulesPayload,
  normalizePagePayload,
  normalizeSubmissionsPayload,
} from "./normalize";
import {
  assertCoursePermitted,
  assertCoursesPermitted,
  assertOperationPermitted,
  assignmentIdSchema,
  type CapabilityMap,
  isOperationPermitted,
  mapDiscoveredTools,
  optionalIsoDateSchema,
  pageSlugSchema,
  permissionSignature,
  type ReadPermissions,
} from "./policy";
import { type ActiveCanvasScope, effectiveTestStudentCourseIds, getActiveCanvasScope } from "./provenance";
import {
  CANVAS_OPERATIONS,
  type CanvasCourse,
  type CanvasListResult,
  CanvasMcpError,
  type CanvasOperation,
  type CanvasSourceItem,
  type McpClient,
  type McpTargetConfig,
  OPERATION_CATEGORY,
  OPERATION_LABELS,
} from "./types";
import { canvasSecretKey, normalizeCanvasBaseUrl, normalizeRemoteMcpUrl } from "./url";

export interface OperationCapabilityStatus {
  operation: CanvasOperation;
  label: string;
  category: CanvasCategory | null;
  supportedByServer: boolean;
  enabledInSettings: boolean;
  mappedToolName: string | null;
  statusText: string;
}

export interface CanvasConnectionSnapshot {
  status: "idle" | "connecting" | "mcp-connected" | "verified" | "error";
  mode: "builtin" | "remote";
  endpointUrl: string | null;
  mcpConnected: boolean;
  canvasAccessVerified: boolean;
  serverName: string | null;
  serverVersion: string | null;
  protocolVersion: string | null;
  capabilityMap: CapabilityMap | null;
  operationStatuses: OperationCapabilityStatus[];
  availableCourses: CanvasCourse[];
  warnings: string[];
  errorMessage: string | null;
  lastCheckedAt: string | null;
}

type Listener = () => void;

function initialSnapshot(mode: "builtin" | "remote"): CanvasConnectionSnapshot {
  return {
    status: "idle",
    mode,
    endpointUrl: null,
    mcpConnected: false,
    canvasAccessVerified: false,
    serverName: null,
    serverVersion: null,
    protocolVersion: null,
    capabilityMap: null,
    operationStatuses: buildOperationStatuses(null, {
      assignments: true,
      submissions: true,
      announcements: true,
      calendar: true,
      modules: true,
    }),
    availableCourses: [],
    warnings: [],
    errorMessage: null,
    lastCheckedAt: null,
  };
}

export function buildOperationStatuses(
  capMap: CapabilityMap | null,
  categories: Readonly<Record<CanvasCategory, boolean>>,
): OperationCapabilityStatus[] {
  return CANVAS_OPERATIONS.map((operation) => {
    const category = OPERATION_CATEGORY[operation];
    const enabledInSettings = category === null ? true : Boolean(categories[category]);
    const mapped = capMap?.mapped[operation] ?? null;
    const supportedByServer = mapped !== null;

    let statusText = "Nog niet gecontroleerd";
    if (capMap) {
      if (!supportedByServer) {
        statusText = "Niet ondersteund door server";
      } else if (!enabledInSettings) {
        statusText = "Uitgeschakeld in instellingen";
      } else {
        statusText = `Gereed (${mapped.toolName})`;
      }
    } else if (!enabledInSettings) {
      statusText = "Uitgeschakeld in instellingen";
    }

    return {
      operation,
      label: OPERATION_LABELS[operation],
      category,
      supportedByServer,
      enabledInSettings,
      mappedToolName: mapped?.toolName ?? null,
      statusText,
    };
  });
}

interface ActiveCall {
  controller: AbortController;
  operation: CanvasOperation;
  courseIds: readonly string[];
}

export class CanvasService {
  private readonly listeners = new Set<Listener>();
  private snapshot: CanvasConnectionSnapshot;
  private activeCalls = new Set<ActiveCall>();
  private courseNameMap = new Map<string, string>();
  private heldItemsByCategory = new Map<CanvasCategory, Map<string, CanvasListResult<CanvasSourceItem>>>();
  private lastSignature: string;
  private lastTransportKey: string;
  private lastTestStudentKey = "";
  private credentialEpoch = 0;

  constructor(
    private readonly data: DataController,
    private readonly mcpClient: McpClient,
    private readonly secrets: SecretStore,
    private readonly supportsBuiltinMcp: boolean,
    /** Set only by an agreeing --testmode=true desktop build. */
    private readonly canvasTestStudent = false,
  ) {
    const effectiveMode = this.getEffectiveMode();
    this.snapshot = initialSnapshot(effectiveMode);
    this.lastSignature = this.computeCurrentSignature();
    this.lastTransportKey = this.computeTransportKey();

    this.data.subscribe(() => {
      this.handleDataChange();
    });
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): CanvasConnectionSnapshot => this.snapshot;

  getCredentialEpoch(): number {
    return this.credentialEpoch;
  }

  getSupportsBuiltinMcp(): boolean {
    return this.supportsBuiltinMcp;
  }

  getActiveScope(): ActiveCanvasScope | null {
    const data = this.data.getSnapshot().data;
    if (!data) return null;
    return getActiveCanvasScope(data, this.supportsBuiltinMcp, this.credentialEpoch, this.canvasTestStudent);
  }

  getSupportsTestStudent(): boolean {
    return this.canvasTestStudent;
  }

  private mapTools(tools: Parameters<typeof mapDiscoveredTools>[0]): CapabilityMap {
    return mapDiscoveredTools(tools, { allowTestStudent: this.canvasTestStudent });
  }

  getCourseName(courseId: string): string | null {
    return this.courseNameMap.get(courseId) ?? null;
  }

  /**
   * Ensures MCP capability discovery has been performed if Canvas/MCP is configured,
   * returning the operations that are both supported by the server and enabled in settings.
   */
  async getAdvertisableOperations(signal?: AbortSignal): Promise<CanvasOperation[]> {
    const data = this.data.getSnapshot().data;
    if (!data) return [];

    let resolved: { target: McpTargetConfig };
    try {
      resolved = await this.resolveTargetConfig();
    } catch {
      return [];
    }

    const { target } = resolved;
    let capMap = this.snapshot.capabilityMap;
    if (!capMap || this.snapshot.endpointUrl !== target.endpointUrl || this.snapshot.mode !== target.mode) {
      try {
        const discovery = await this.mcpClient.discover(target, signal);
        capMap = this.mapTools(discovery.tools);
        this.snapshot = {
          ...this.snapshot,
          mcpConnected: true,
          mode: target.mode,
          endpointUrl: target.endpointUrl,
          serverName: discovery.serverName,
          serverVersion: discovery.serverVersion,
          protocolVersion: discovery.protocolVersion,
          capabilityMap: capMap,
          operationStatuses: buildOperationStatuses(capMap, target.permissions.categories),
        };
        this.emit();
      } catch {
        return [];
      }
    }

    const permissions = this.getCurrentPermissions();
    if (permissions.selectedCourseIds.length === 0) {
      // Without any selected courses, only `courses` can be listed if supported
      return capMap.mapped.courses ? ["courses"] : [];
    }

    const allowed: CanvasOperation[] = [];
    for (const op of CANVAS_OPERATIONS) {
      if (!capMap.mapped[op]) continue;
      if (!isOperationPermitted(op, permissions)) continue;
      allowed.push(op);
    }
    return allowed;
  }

  /** Returns cached/held items for a category & course if still valid under current permissions. */
  getHeldItems(category: CanvasCategory, courseId: string): CanvasListResult<CanvasSourceItem> | null {
    const permissions = this.getCurrentPermissions();
    if (!permissions.categories[category]) return null;
    if (!permissions.selectedCourseIds.includes(courseId)) return null;
    return this.heldItemsByCategory.get(category)?.get(courseId) ?? null;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private getEffectiveMode(): "builtin" | "remote" {
    const data = this.data.getSnapshot().data;
    const mode = data?.settings.mcp.mode ?? "remote";
    return this.supportsBuiltinMcp ? mode : "remote";
  }

  private getCurrentPermissions(): ReadPermissions {
    const data = this.data.getSnapshot().data;
    return {
      selectedCourseIds: data?.settings.canvas.selectedCourseIds ?? [],
      categories: data?.settings.canvas.categories ?? {
        assignments: true,
        submissions: true,
        announcements: true,
        calendar: true,
        modules: true,
      },
      testStudentCourseIds: data
        ? effectiveTestStudentCourseIds(data, this.supportsBuiltinMcp, this.canvasTestStudent)
        : [],
    };
  }

  /** True when submissions for this course are read as the Canvas Test Student. */
  isTestStudentCourse(courseId: string): boolean {
    return (this.getCurrentPermissions().testStudentCourseIds ?? []).includes(courseId);
  }

  private computeTransportKey(): string {
    const data = this.data.getSnapshot().data;
    const mode = this.getEffectiveMode();
    if (mode === "builtin") {
      const norm = normalizeCanvasBaseUrl(data?.settings.canvas.baseUrl ?? "");
      return `builtin|${norm.ok ? norm.url : ""}`;
    }
    const norm = normalizeRemoteMcpUrl(data?.settings.mcp.remoteUrl ?? "");
    return `remote|${norm.ok ? norm.url : ""}`;
  }

  private computeCurrentSignature(): string {
    const permissions = this.getCurrentPermissions();
    const data = this.data.getSnapshot().data;
    const mode = this.getEffectiveMode();
    const endpoint =
      mode === "builtin"
        ? (data?.settings.canvas.baseUrl ?? "").trim()
        : (data?.settings.mcp.remoteUrl ?? "").trim();
    return permissionSignature(mode, endpoint, permissions);
  }

  private handleDataChange(): void {
    const nextTransportKey = this.computeTransportKey();
    const nextSignature = this.computeCurrentSignature();
    const permissions = this.getCurrentPermissions();

    if (nextTransportKey !== this.lastTransportKey) {
      this.lastTransportKey = nextTransportKey;
      this.lastSignature = nextSignature;
      this.cancelAllInFlight();
      this.heldItemsByCategory.clear();
      this.courseNameMap.clear();
      void this.mcpClient.disconnect().catch(() => undefined);
      this.snapshot = initialSnapshot(this.getEffectiveMode());
      this.snapshot.operationStatuses = buildOperationStatuses(null, permissions.categories);
      this.emit();
      return;
    }

    if (nextSignature !== this.lastSignature) {
      this.lastSignature = nextSignature;
      this.enforcePermissionShrink(permissions);
      const testKey = [...(permissions.testStudentCourseIds ?? [])].sort().join(",");
      if (testKey !== this.lastTestStudentKey) {
        this.lastTestStudentKey = testKey;
        for (const call of [...this.activeCalls]) {
          if (call.operation === "submissions") {
            call.controller.abort();
            this.activeCalls.delete(call);
          }
        }
        this.heldItemsByCategory.delete("submissions");
      }
      this.snapshot = {
        ...this.snapshot,
        mode: this.getEffectiveMode(),
        operationStatuses: buildOperationStatuses(this.snapshot.capabilityMap, permissions.categories),
      };
      this.emit();
    }
  }

  /**
   * Immediately cancels any in-flight calls and invalidates cached/held results
   * whose category or course was disabled/deselected.
   */
  private enforcePermissionShrink(permissions: ReadPermissions): void {
    const allowedCourses = new Set(permissions.selectedCourseIds);

    for (const call of [...this.activeCalls]) {
      const cat = OPERATION_CATEGORY[call.operation];
      const catDisabled = cat !== null && !permissions.categories[cat];
      const courseRemoved = call.courseIds.some((id) => !allowedCourses.has(id));
      if (catDisabled || courseRemoved) {
        call.controller.abort();
        this.activeCalls.delete(call);
      }
    }

    for (const [cat, byCourse] of this.heldItemsByCategory.entries()) {
      if (!permissions.categories[cat]) {
        this.heldItemsByCategory.delete(cat);
        continue;
      }
      for (const courseId of [...byCourse.keys()]) {
        if (!allowedCourses.has(courseId)) {
          byCourse.delete(courseId);
        }
      }
    }
  }

  cancelAllInFlight(): void {
    for (const call of this.activeCalls) {
      call.controller.abort();
    }
    this.activeCalls.clear();
  }

  /** Call when a credential changes to reset sessions and cached data. */
  async notifyCredentialChanged(): Promise<void> {
    this.credentialEpoch += 1;
    this.cancelAllInFlight();
    this.heldItemsByCategory.clear();
    this.courseNameMap.clear();
    await this.mcpClient.disconnect().catch(() => undefined);
    this.snapshot = {
      ...initialSnapshot(this.getEffectiveMode()),
      operationStatuses: buildOperationStatuses(null, this.getCurrentPermissions().categories),
    };
    this.emit();
  }

  private async resolveTargetConfig(): Promise<{ target: McpTargetConfig; expectedCanvasOrigin?: string }> {
    const data = this.data.getSnapshot().data;
    if (!data) {
      throw new CanvasMcpError("config", "Gegevens zijn nog niet geladen.");
    }
    const state = data.settings;
    const mode = this.getEffectiveMode();
    const permissions: McpTargetConfig["permissions"] = {
      selectedCourseIds: [...state.canvas.selectedCourseIds],
      categories: { ...state.canvas.categories },
    };
    if (this.canvasTestStudent && mode === "builtin") {
      permissions.testStudentCourseIds = effectiveTestStudentCourseIds(data, this.supportsBuiltinMcp, true);
    }

    if (mode === "builtin") {
      if (!this.supportsBuiltinMcp) {
        throw new CanvasMcpError(
          "unsupported",
          "De ingebouwde Canvas MCP-server is alleen beschikbaar in de desktop-app. Kies de externe MCP-URL in de browser.",
        );
      }
      const norm = normalizeCanvasBaseUrl(state.canvas.baseUrl);
      if (!norm.ok) {
        throw new CanvasMcpError("config", norm.error);
      }
      const hasToken = await this.secrets.has(canvasSecretKey(norm.url));
      if (!hasToken) {
        throw new CanvasMcpError(
          "missing-secret",
          "Geen Canvas-toegangstoken opgeslagen voor deze Canvas-URL. Sla eerst je persoonlijke Canvas-token op onder Instellingen → Canvas.",
        );
      }
      return {
        target: { mode: "builtin", endpointUrl: norm.url, permissions },
        expectedCanvasOrigin: norm.origin,
      };
    }

    const norm = normalizeRemoteMcpUrl(state.mcp.remoteUrl);
    if (!norm.ok) {
      throw new CanvasMcpError("config", norm.error);
    }
    const canvasNorm = state.canvas.baseUrl.trim() ? normalizeCanvasBaseUrl(state.canvas.baseUrl) : null;
    return {
      target: { mode: "remote", endpointUrl: norm.url, permissions },
      expectedCanvasOrigin: canvasNorm && canvasNorm.ok ? canvasNorm.origin : undefined,
    };
  }

  /**
   * Tests the MCP connection (protocol handshake + tool discovery) AND verifies real Canvas access
   * by executing the reviewed `courses` read tool. Distinguishes MCP reachability from Canvas access.
   */
  async testConnectionAndLoadCourses(): Promise<CanvasConnectionSnapshot> {
    const permissions = this.getCurrentPermissions();
    const mode = this.getEffectiveMode();

    let resolved: { target: McpTargetConfig; expectedCanvasOrigin?: string };
    try {
      resolved = await this.resolveTargetConfig();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Ongeldige configuratie.";
      this.snapshot = {
        ...initialSnapshot(mode),
        status: "error",
        errorMessage: msg,
        operationStatuses: buildOperationStatuses(null, permissions.categories),
        lastCheckedAt: new Date().toISOString(),
      };
      this.emit();
      return this.snapshot;
    }

    const { target, expectedCanvasOrigin } = resolved;
    this.snapshot = {
      ...this.snapshot,
      status: "connecting",
      mode: target.mode,
      endpointUrl: target.endpointUrl,
      errorMessage: null,
      warnings: [],
    };
    this.emit();

    const callEntry: ActiveCall = {
      controller: new AbortController(),
      operation: "courses",
      courseIds: [],
    };
    this.activeCalls.add(callEntry);

    try {
      const discovery = await this.mcpClient.discover(target, callEntry.controller.signal);
      const capabilityMap = this.mapTools(discovery.tools);
      const operationStatuses = buildOperationStatuses(capabilityMap, permissions.categories);

      // Update snapshot to show MCP handshake & discovery succeeded
      this.snapshot = {
        ...this.snapshot,
        status: "mcp-connected",
        mcpConnected: true,
        canvasAccessVerified: false,
        serverName: discovery.serverName,
        serverVersion: discovery.serverVersion,
        protocolVersion: discovery.protocolVersion,
        capabilityMap,
        operationStatuses,
        lastCheckedAt: new Date().toISOString(),
      };
      this.emit();

      const coursesTool = capabilityMap.mapped.courses;
      if (!coursesTool) {
        this.snapshot = {
          ...this.snapshot,
          status: "error",
          errorMessage:
            "MCP-verbinding is gelukt, maar deze MCP-server biedt geen gecontroleerde functie om Canvas-cursussen te lezen (canvas_list_courses).",
          lastCheckedAt: new Date().toISOString(),
        };
        this.emit();
        return this.snapshot;
      }

      // Now perform a real Canvas read to verify Canvas access
      const callResult = await this.mcpClient.callTool(
        target,
        coursesTool.toolName,
        {},
        callEntry.controller.signal,
      );

      if (callResult.isError) {
        this.snapshot = {
          ...this.snapshot,
          status: "error",
          errorMessage: `MCP-verbinding actief (${discovery.serverName}), maar Canvas-toegang mislukte: ${callResult.textContent || "Onbekende fout van de server."}`,
          lastCheckedAt: new Date().toISOString(),
        };
        this.emit();
        return this.snapshot;
      }

      const payload = callResult.structuredContent ?? callResult.textContent;
      const normalized = normalizeCoursesPayload(payload, expectedCanvasOrigin);
      for (const course of normalized.items) {
        this.courseNameMap.set(course.id, course.name);
      }

      this.snapshot = {
        ...this.snapshot,
        status: "verified",
        mcpConnected: true,
        canvasAccessVerified: true,
        availableCourses: normalized.items,
        warnings: normalized.warnings,
        errorMessage: null,
        lastCheckedAt: normalized.retrievedAt,
      };
      this.emit();
      return this.snapshot;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Verbinding met MCP/Canvas is mislukt.";
      const mcpWasConnected = this.snapshot.mcpConnected;
      this.snapshot = {
        ...this.snapshot,
        status: "error",
        canvasAccessVerified: false,
        errorMessage: mcpWasConnected
          ? `MCP-verbinding actief, maar Canvas-toegang mislukte: ${msg}`
          : msg,
        lastCheckedAt: new Date().toISOString(),
      };
      this.emit();
      return this.snapshot;
    } finally {
      this.activeCalls.delete(callEntry);
    }
  }

  private async ensureMappedTool(
    target: McpTargetConfig,
    operation: CanvasOperation,
    signal: AbortSignal,
  ): Promise<string> {
    let capMap = this.snapshot.capabilityMap;
    if (!capMap || this.snapshot.endpointUrl !== target.endpointUrl || this.snapshot.mode !== target.mode) {
      const discovery = await this.mcpClient.discover(target, signal);
      capMap = this.mapTools(discovery.tools);
      this.snapshot = {
        ...this.snapshot,
        mcpConnected: true,
        serverName: discovery.serverName,
        serverVersion: discovery.serverVersion,
        protocolVersion: discovery.protocolVersion,
        capabilityMap: capMap,
        operationStatuses: buildOperationStatuses(capMap, target.permissions.categories),
      };
      this.emit();
    }
    const mapped = capMap.mapped[operation];
    if (!mapped) {
      throw new CanvasMcpError(
        "unsupported",
        `De MCP-server ondersteunt de functie "${OPERATION_LABELS[operation]}" niet met een goedgekeurd leesschema.`,
      );
    }
    return mapped.toolName;
  }

  private async executeCategorizedRead<T>(
    operation: CanvasOperation,
    courseIds: readonly string[],
    externalSignal: AbortSignal | undefined,
    runner: (
      target: McpTargetConfig,
      toolName: string,
      expectedCanvasOrigin: string | undefined,
      signal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T> {
    if (externalSignal?.aborted) {
      throw new CanvasMcpError("aborted", "De leesactie is geannuleerd.");
    }
    const permissions = this.getCurrentPermissions();
    assertOperationPermitted(operation, permissions);

    const { target, expectedCanvasOrigin } = await this.resolveTargetConfig();
    const signatureAtStart = this.computeCurrentSignature();
    const epochAtStart = this.credentialEpoch;

    const callEntry: ActiveCall = {
      controller: new AbortController(),
      operation,
      courseIds,
    };
    this.activeCalls.add(callEntry);
    const onExternalAbort = () => callEntry.controller.abort();
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      const toolName = await this.ensureMappedTool(target, operation, callEntry.controller.signal);
      const result = await runner(target, toolName, expectedCanvasOrigin, callEntry.controller.signal);

      if (
        callEntry.controller.signal.aborted ||
        this.computeCurrentSignature() !== signatureAtStart ||
        this.credentialEpoch !== epochAtStart
      ) {
        throw new CanvasMcpError(
          "aborted",
          "De leesactie is geannuleerd omdat de Canvas-toestemmingen of cursusselectie zijn gewijzigd.",
        );
      }
      return result;
    } catch (err) {
      if (externalSignal?.aborted) {
        throw new CanvasMcpError("aborted", "De leesactie is geannuleerd.");
      }
      if (callEntry.controller.signal.aborted) {
        throw new CanvasMcpError(
          "aborted",
          "De leesactie is geannuleerd omdat de Canvas-toestemmingen of cursusselectie zijn gewijzigd.",
        );
      }
      throw err;
    } finally {
      externalSignal?.removeEventListener("abort", onExternalAbort);
      this.activeCalls.delete(callEntry);
    }
  }

  private cacheCategoryResult(
    category: CanvasCategory,
    courseId: string,
    result: CanvasListResult<CanvasSourceItem>,
  ): void {
    const permissions = this.getCurrentPermissions();
    if (!permissions.categories[category] || !permissions.selectedCourseIds.includes(courseId)) {
      return;
    }
    let byCourse = this.heldItemsByCategory.get(category);
    if (!byCourse) {
      byCourse = new Map();
      this.heldItemsByCategory.set(category, byCourse);
    }
    byCourse.set(courseId, result);
  }

  async listCourses(signal?: AbortSignal): Promise<CanvasListResult<CanvasCourse>> {
    return this.executeCategorizedRead("courses", [], signal, async (target, toolName, expectedOrigin, innerSignal) => {
      const res = await this.mcpClient.callTool(target, toolName, {}, innerSignal);
      if (res.isError) {
        throw new CanvasMcpError("protocol", res.textContent || "Fout bij het ophalen van cursussen.");
      }
      const normalized = normalizeCoursesPayload(res.structuredContent ?? res.textContent, expectedOrigin);
      for (const c of normalized.items) {
        this.courseNameMap.set(c.id, c.name);
      }
      return normalized;
    });
  }

  async listAssignments(
    courseId: string,
    options?: { searchTerm?: string; signal?: AbortSignal },
  ): Promise<CanvasListResult<CanvasSourceItem>> {
    const permissions = this.getCurrentPermissions();
    const validCourseId = assertCoursePermitted(courseId, permissions);

    return this.executeCategorizedRead(
      "assignments",
      [validCourseId],
      options?.signal,
      async (target, toolName, expectedOrigin, signal) => {
        // Never send Canvas deadline buckets (upcoming/past/…); overdue work must stay visible.
        const args: Record<string, unknown> = { course_id: validCourseId };
        if (options?.searchTerm) args.search_term = options.searchTerm;

        const res = await this.mcpClient.callTool(target, toolName, args, signal);
        if (res.isError) {
          throw new CanvasMcpError("protocol", res.textContent || "Fout bij het ophalen van opdrachten.");
        }
        const normalized = normalizeAssignmentsPayload(
          res.structuredContent ?? res.textContent,
          validCourseId,
          this.courseNameMap,
          expectedOrigin,
        );
        this.cacheCategoryResult("assignments", validCourseId, normalized);
        return normalized;
      },
    );
  }

  async listOwnSubmissions(
    courseId: string,
    assignmentIds?: readonly string[],
    signal?: AbortSignal,
  ): Promise<CanvasListResult<CanvasSourceItem>> {
    const permissions = this.getCurrentPermissions();
    const validCourseId = assertCoursePermitted(courseId, permissions);
    const validAssignmentIds = assignmentIds?.map((id) => {
      const parsed = assignmentIdSchema.safeParse(id);
      if (!parsed.success) throw new CanvasMcpError("permission", "Ongeldig opdracht-ID.");
      return parsed.data;
    });
    const asTestStudent = this.isTestStudentCourse(validCourseId);

    return this.executeCategorizedRead(
      "submissions",
      [validCourseId],
      signal,
      async (target, ownToolName, expectedOrigin, innerSignal) => {
        let toolName = ownToolName;
        if (asTestStudent) {
          const testTool = this.snapshot.capabilityMap?.testStudentTool;
          if (!testTool || !target.permissions.testStudentCourseIds?.includes(validCourseId)) {
            throw new CanvasMcpError(
              "unsupported",
              "Testbuild: de verbonden MCP-server biedt geen gecontroleerde Canvas Test Student-functie voor deze cursus.",
            );
          }
          toolName = testTool.toolName;
        }
        const args: Record<string, unknown> = { course_id: validCourseId };
        if (validAssignmentIds && validAssignmentIds.length > 0) {
          args.assignment_ids = validAssignmentIds;
        }
        const res = await this.mcpClient.callTool(target, toolName, args, innerSignal);
        if (res.isError) {
          throw new CanvasMcpError(
            "protocol",
            res.textContent ||
              (asTestStudent
                ? "Fout bij het ophalen van de inleverstatus van de Canvas Test Student."
                : "Fout bij het ophalen van eigen inleverstatus."),
          );
        }
        let normalized = normalizeSubmissionsPayload(
          res.structuredContent ?? res.textContent,
          validCourseId,
          this.courseNameMap,
          expectedOrigin,
        );
        if (asTestStudent) {
          normalized = {
            ...normalized,
            testStudent: true,
            items: normalized.items.map((item) => ({ ...item, id: `${item.id}:teststudent`, testStudent: true })),
          };
        }
        this.cacheCategoryResult("submissions", validCourseId, normalized);
        return normalized;
      },
    );
  }

  async listAnnouncements(
    courseIds?: readonly string[],
    options?: { startDate?: string; endDate?: string; signal?: AbortSignal },
  ): Promise<CanvasListResult<CanvasSourceItem>> {
    const permissions = this.getCurrentPermissions();
    const targetCourses = assertCoursesPermitted(courseIds ?? permissions.selectedCourseIds, permissions);
    const startDate = optionalIsoDateSchema.parse(options?.startDate);
    const endDate = optionalIsoDateSchema.parse(options?.endDate);

    return this.executeCategorizedRead(
      "announcements",
      targetCourses,
      options?.signal,
      async (target, toolName, expectedOrigin, signal) => {
        const args: Record<string, unknown> = { course_ids: targetCourses };
        if (startDate) args.start_date = startDate;
        if (endDate) args.end_date = endDate;

        const res = await this.mcpClient.callTool(target, toolName, args, signal);
        if (res.isError) {
          throw new CanvasMcpError("protocol", res.textContent || "Fout bij het ophalen van announcements.");
        }
        const normalized = normalizeAnnouncementsPayload(
          res.structuredContent ?? res.textContent,
          new Set(targetCourses),
          this.courseNameMap,
          expectedOrigin,
        );
        for (const cId of targetCourses) {
          this.cacheCategoryResult("announcements", cId, {
            ...normalized,
            items: normalized.items.filter((i) => i.courseId === cId),
          });
        }
        return normalized;
      },
    );
  }

  async listCalendarEvents(
    courseIds?: readonly string[],
    options?: { startDate?: string; endDate?: string; signal?: AbortSignal },
  ): Promise<CanvasListResult<CanvasSourceItem>> {
    const permissions = this.getCurrentPermissions();
    const targetCourses = assertCoursesPermitted(courseIds ?? permissions.selectedCourseIds, permissions);
    const startDate = optionalIsoDateSchema.parse(options?.startDate);
    const endDate = optionalIsoDateSchema.parse(options?.endDate);

    return this.executeCategorizedRead(
      "calendar",
      targetCourses,
      options?.signal,
      async (target, toolName, expectedOrigin, signal) => {
        const args: Record<string, unknown> = { course_ids: targetCourses };
        if (startDate) args.start_date = startDate;
        if (endDate) args.end_date = endDate;

        const res = await this.mcpClient.callTool(target, toolName, args, signal);
        if (res.isError) {
          throw new CanvasMcpError("protocol", res.textContent || "Fout bij het ophalen van agenda-items.");
        }
        const normalized = normalizeCalendarEventsPayload(
          res.structuredContent ?? res.textContent,
          new Set(targetCourses),
          this.courseNameMap,
          expectedOrigin,
        );
        for (const cId of targetCourses) {
          this.cacheCategoryResult("calendar", cId, {
            ...normalized,
            items: normalized.items.filter((i) => i.courseId === cId),
          });
        }
        return normalized;
      },
    );
  }

  async listModules(
    courseId: string,
    searchTerm?: string,
    signal?: AbortSignal,
  ): Promise<CanvasListResult<CanvasSourceItem>> {
    const permissions = this.getCurrentPermissions();
    const validCourseId = assertCoursePermitted(courseId, permissions);

    return this.executeCategorizedRead(
      "modules",
      [validCourseId],
      signal,
      async (target, toolName, expectedOrigin, innerSignal) => {
        const args: Record<string, unknown> = { course_id: validCourseId };
        if (searchTerm?.trim()) args.search_term = searchTerm.trim();

        const res = await this.mcpClient.callTool(target, toolName, args, innerSignal);
        if (res.isError) {
          throw new CanvasMcpError("protocol", res.textContent || "Fout bij het ophalen van modules.");
        }
        const normalized = normalizeModulesPayload(
          res.structuredContent ?? res.textContent,
          validCourseId,
          this.getCurrentPermissions().categories,
          this.courseNameMap,
          expectedOrigin,
        );
        this.cacheCategoryResult("modules", validCourseId, normalized);
        return normalized;
      },
    );
  }

  async getPageContent(
    courseId: string,
    pageUrlOrId: string,
    signal?: AbortSignal,
  ): Promise<CanvasSourceItem> {
    const permissions = this.getCurrentPermissions();
    const validCourseId = assertCoursePermitted(courseId, permissions);
    const parsedSlug = pageSlugSchema.safeParse(pageUrlOrId);
    if (!parsedSlug.success) {
      throw new CanvasMcpError("permission", parsedSlug.error.issues[0]?.message ?? "Ongeldige pagina-identificatie.");
    }

    return this.executeCategorizedRead(
      "page",
      [validCourseId],
      signal,
      async (target, toolName, expectedOrigin, innerSignal) => {
        const res = await this.mcpClient.callTool(
          target,
          toolName,
          { course_id: validCourseId, page_url_or_id: parsedSlug.data },
          innerSignal,
        );
        if (res.isError) {
          throw new CanvasMcpError("protocol", res.textContent || "Fout bij het ophalen van de Canvas-pagina.");
        }
        return normalizePagePayload(
          res.structuredContent ?? res.textContent,
          validCourseId,
          parsedSlug.data,
          this.courseNameMap,
          expectedOrigin,
        );
      },
    );
  }
}
