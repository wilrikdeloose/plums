import { describe, expect, it } from "vitest";
import { MemorySecretStore } from "../../web/memorySecretStore";
import { isMessagePermittedInContext } from "../ai/context";
import { DataController } from "../dataController";
import { checkImport } from "../dataTransfer";
import type { DataStore, Platform, StorageInfo } from "../platform";
import { createDefaultData, serializeAppData, validateAppData, type AppData, type Message } from "../schema";
import { CanvasService } from "./canvasService";
import { mapDiscoveredTools, TEST_STUDENT_TOOL } from "./policy";
import { filterAllowedSources, getActiveCanvasScope, isPlanAllowed, isProvenanceAllowed } from "./provenance";
import type { McpClient, McpTargetConfig, McpToolDescriptor } from "./types";
import { canvasSecretKey } from "./url";

const CANVAS = "https://fhict.instructure.com";

function tool(name: string, properties: Record<string, unknown>): McpToolDescriptor {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties, required: Object.keys(properties).slice(0, 1) },
    annotations: { readOnlyHint: true, destructiveHint: false },
  };
}

const SUBMISSION_PROPS = { course_id: { type: "string" }, assignment_ids: { type: "array", items: { type: "string" } } };
const OWN_TOOL = tool("canvas_get_own_submissions", SUBMISSION_PROPS);
const TEST_TOOL = tool(TEST_STUDENT_TOOL, SUBMISSION_PROPS);

function savedWithTestSettings(): AppData {
  const data = createDefaultData(true);
  data.settings.canvas.selectedCourseIds = ["101"];
  data.settings.canvas.testStudentCourseIds = ["101"];
  data.ownTasks.push({
    id: "t1",
    title: "Eigen taak",
    notes: "",
    dueAt: null,
    estimateMinutes: null,
    priority: "middel",
    done: false,
    createdAt: "2026-10-15T08:00:00.000Z",
  });
  return data;
}

class MemoryStore implements DataStore {
  constructor(public raw: unknown | null = null) {}
  async info(): Promise<StorageInfo> {
    return { type: "Geheugen", location: "memory" };
  }
  async load() {
    return this.raw ? structuredClone(this.raw) : null;
  }
  async save(data: unknown) {
    this.raw = structuredClone(data);
  }
  async clear() {
    this.raw = null;
  }
  async quarantine() {
    return "q";
  }
}

function platformWith(mcp: McpClient, store: DataStore, canvasTestStudent?: boolean): Platform {
  return {
    id: "desktop",
    dataStore: store,
    files: { saveJson: async () => false, openJson: async () => null },
    secrets: new MemorySecretStore(),
    http: { request: async () => Promise.reject(new Error("unused")) },
    mcp,
    capabilities: { builtInMcp: true, ...(canvasTestStudent === undefined ? {} : { canvasTestStudent }) },
  };
}

function recordingMcp(tools: McpToolDescriptor[]) {
  const calls: { toolName: string; target: McpTargetConfig }[] = [];
  const client: McpClient = {
    async discover() {
      return { serverName: "plums-canvas-builtin", serverVersion: "0.1.0", protocolVersion: "2025-11-25", tools };
    },
    async callTool(target, toolName) {
      calls.push({ toolName, target: structuredClone(target) });
      return {
        isError: false,
        structuredContent: {
          items: [{ assignment_id: "555", course_id: "101", assignment_name: "Portfolio", workflow_state: "unsubmitted", due_at: null }],
          enrollmentStatus: toolName === TEST_STUDENT_TOOL ? "test_student" : "student",
          truncated: false,
          warnings: [],
          retrievedAt: "2026-10-15T08:00:00Z",
        },
        textContent: "{}",
      };
    },
    async disconnect() {},
  };
  return { client, calls };
}

async function serviceFor(tools: McpToolDescriptor[], canvasTestStudent: boolean, mode: "builtin" | "remote" = "builtin") {
  const { client, calls } = recordingMcp(tools);
  const platform = platformWith(client, new MemoryStore(savedWithTestSettings()), canvasTestStudent);
  const controller = new DataController(platform);
  await controller.load();
  // Simulates a value arriving after load (e.g. a direct state mutation); the service must still gate it.
  controller.update((d) => {
    d.settings.canvas.testStudentCourseIds = ["101"];
    d.settings.mcp.mode = mode;
    d.settings.mcp.remoteUrl = "https://mcp.example.test/mcp";
  });
  await platform.secrets.save(canvasSecretKey(CANVAS), "canvas-token");
  const service = new CanvasService(controller, client, platform.secrets, true, canvasTestStudent);
  return { service, calls };
}

describe("Canvas Test Student build gate", () => {
  it("normal builds discard saved and imported Test Student settings but keep ordinary data", async () => {
    const raw = JSON.parse(serializeAppData(savedWithTestSettings()));

    const normal = validateAppData(raw, true);
    expect(normal.ok && normal.data.settings.canvas.testStudentCourseIds).toEqual([]);
    expect(normal.ok && normal.data.settings.canvas.selectedCourseIds).toEqual(["101"]);
    expect(normal.ok && normal.data.ownTasks).toHaveLength(1);
    expect(normal.ok && normal.notes.some((n) => n.includes("Test Student"))).toBe(true);

    const test = validateAppData(raw, true, true);
    expect(test.ok && test.data.settings.canvas.testStudentCourseIds).toEqual(["101"]);

    const store = new MemoryStore(raw);
    const controller = new DataController(platformWith(recordingMcp([]).client, store));
    await controller.load();
    expect(controller.getSnapshot().data?.settings.canvas.testStudentCourseIds).toEqual([]);

    const imported = checkImport(platformWith(recordingMcp([]).client, new MemoryStore()), JSON.stringify(raw));
    expect(imported.ok && imported.data.settings.canvas.testStudentCourseIds).toEqual([]);
    const importedTest = checkImport(platformWith(recordingMcp([]).client, new MemoryStore(), true), JSON.stringify(raw));
    expect(importedTest.ok && importedTest.data.settings.canvas.testStudentCourseIds).toEqual(["101"]);

    // Older documents without the field still load.
    delete raw.settings.canvas.testStudentCourseIds;
    expect(validateAppData(raw, true).ok).toBe(true);
  });

  it("maps the Test Student tool only when allowed and never with a student parameter", () => {
    const normal = mapDiscoveredTools([OWN_TOOL, TEST_TOOL]);
    expect(normal.testStudentTool).toBeUndefined();
    expect(normal.rejectedTools.map((r) => r.name)).toContain(TEST_STUDENT_TOOL);
    expect(normal.mapped.submissions?.toolName).toBe("canvas_get_own_submissions");

    const test = mapDiscoveredTools([OWN_TOOL, TEST_TOOL], { allowTestStudent: true });
    expect(test.testStudentTool?.toolName).toBe(TEST_STUDENT_TOOL);
    expect(test.mapped.submissions?.toolName).toBe("canvas_get_own_submissions");

    const unsafe = tool(TEST_STUDENT_TOOL, { course_id: { type: "string" }, student_id: { type: "string" } });
    const rejected = mapDiscoveredTools([unsafe], { allowTestStudent: true });
    expect(rejected.testStudentTool).toBeUndefined();
    expect(rejected.rejectedTools[0]?.reason).toContain("student_id");
  });

  it("excludes Test Student-derived messages, sources and plans outside an agreeing test build", () => {
    const data = savedWithTestSettings();
    const normalScope = getActiveCanvasScope(data, true, 0);
    const testScope = getActiveCanvasScope(data, true, 0, true);
    expect([...normalScope.testStudentCourseIds]).toEqual([]);
    expect([...testScope.testStudentCourseIds]).toEqual(["101"]);

    const provenance = {
      scopeId: normalScope.scopeId,
      courseIds: ["101"],
      categories: ["submissions" as const],
      sourceIds: ["canvas:submission:101:555:teststudent"],
      testStudentCourseIds: ["101"],
    };
    const message: Message = {
      id: "m1",
      role: "assistant",
      content: "Volgens de Canvas Test Student is Portfolio nog niet ingeleverd.",
      createdAt: "2026-10-15T08:00:00.000Z",
      status: "completed",
      canvasProvenance: provenance,
    };
    expect(isProvenanceAllowed(provenance, normalScope)).toBe(false);
    expect(isMessagePermittedInContext(message, normalScope)).toBe(false);
    expect(isMessagePermittedInContext(message, testScope)).toBe(true);
    const { testStudentCourseIds: _unused, ...ownProvenance } = provenance;
    expect(isProvenanceAllowed(ownProvenance, normalScope)).toBe(true);

    const source = {
      id: "s1",
      category: "submissions" as const,
      courseId: "101",
      title: "Portfolio",
      retrievedAt: "2026-10-15T08:00:00Z",
    };
    expect(filterAllowedSources([{ ...source, testStudent: true }, source], normalScope)).toEqual([source]);

    const plan = {
      id: "p1",
      title: "Week",
      scope: "week" as const,
      startDate: "2026-10-19",
      conversationId: null,
      createdAt: "2026-10-15T08:00:00.000Z",
      updatedAt: "2026-10-15T08:00:00.000Z",
      blocks: [],
      status: "complete" as const,
      revision: 1,
      assumptions: [],
      warnings: [],
      unscheduled: [],
      capacityShortfallMinutes: 0,
      oneOffConstraints: [],
    };
    expect(isPlanAllowed({ ...plan, testStudentCourseIds: ["101"] }, normalScope)).toBe(false);
    expect(isPlanAllowed({ ...plan, testStudentCourseIds: ["101"] }, testScope)).toBe(true);
    expect(isPlanAllowed(plan, normalScope)).toBe(true);
  });

  it("normal build: own-user tool only, no test permissions sent even if state contains test courses", async () => {
    const { service, calls } = await serviceFor([OWN_TOOL, TEST_TOOL], false);
    const res = await service.listOwnSubmissions("101");
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("canvas_get_own_submissions");
    expect(calls[0].target.permissions).not.toHaveProperty("testStudentCourseIds");
    expect(res.testStudent).toBeUndefined();
    expect(service.getActiveScope()?.testStudentCourseIds.size).toBe(0);
  });

  it("agreeing test build: routes the opted-in course to the Test Student tool and labels results", async () => {
    const { service, calls } = await serviceFor([OWN_TOOL, TEST_TOOL], true);
    const res = await service.listOwnSubmissions("101");
    expect(calls[0].toolName).toBe(TEST_STUDENT_TOOL);
    expect(calls[0].target.permissions.testStudentCourseIds).toEqual(["101"]);
    expect(res.testStudent).toBe(true);
    expect(res.items[0].testStudent).toBe(true);
    expect(res.items[0].id).toMatch(/:teststudent$/);
  });

  it("test frontend with a server lacking the reviewed tool denies instead of falling back", async () => {
    const { service, calls } = await serviceFor([OWN_TOOL], true);
    await expect(service.listOwnSubmissions("101")).rejects.toMatchObject({ kind: "unsupported" });
    expect(calls).toHaveLength(0);
  });

  it("remote MCP stays own-user only, even in a test build", async () => {
    const { service, calls } = await serviceFor([OWN_TOOL, TEST_TOOL], true, "remote");
    await service.listOwnSubmissions("101");
    expect(calls[0].toolName).toBe("canvas_get_own_submissions");
    expect(calls[0].target.permissions).not.toHaveProperty("testStudentCourseIds");
  });
});
