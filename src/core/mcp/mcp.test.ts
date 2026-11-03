import { describe, expect, it } from "vitest";
import { DataController } from "../dataController";
import {
  type DataStore,
  type FileTransfer,
  type HttpTransport,
  type Platform,
  type StorageInfo,
} from "../platform";
import { MemorySecretStore } from "../../web/memorySecretStore";
import { BrowserRemoteMcpClient } from "../../web/remoteMcpClient";
import { CanvasService } from "./canvasService";
import { htmlToPlainText } from "./html";
import {
  normalizeAnnouncementsPayload,
  normalizeAssignmentsPayload,
  normalizeCalendarEventsPayload,
  normalizeCoursesPayload,
  normalizeModulesPayload,
  normalizePagePayload,
  normalizeSubmissionsPayload,
} from "./normalize";
import { mapDiscoveredTools } from "./policy";
import { CanvasMcpError, type McpClient, type McpToolDescriptor } from "./types";
import {
  canvasSecretKey,
  normalizeCanvasBaseUrl,
  normalizeRemoteMcpUrl,
  remoteMcpSecretKey,
} from "./url";

class InMemoryDataStore implements DataStore {
  raw: unknown | null = null;
  async info(): Promise<StorageInfo> {
    return { type: "Geheugen", location: "memory" };
  }
  async load(): Promise<unknown | null> {
    return this.raw ? structuredClone(this.raw) : null;
  }
  async save(data: unknown): Promise<void> {
    this.raw = structuredClone(data);
  }
  async clear(): Promise<void> {
    this.raw = null;
  }
  async quarantine(): Promise<string> {
    this.raw = null;
    return "memory.quarantined";
  }
}

const noopFiles: FileTransfer = {
  async saveJson() {
    return false;
  },
  async openJson() {
    return null;
  },
};

const noopHttp: HttpTransport = {
  async request() {
    throw new Error("not used");
  },
};

const STANDARD_TOOLS: McpToolDescriptor[] = [
  {
    name: "canvas_list_courses",
    description: "Leest actieve cursussen",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "canvas_list_assignments",
    description: "Leest opdrachten voor een cursus",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "string" },
        bucket: { type: "string" },
        search_term: { type: "string" },
      },
      required: ["course_id"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "canvas_get_own_submissions",
    description: "Leest eigen inleverstatus",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "string" },
        assignment_ids: { type: "array", items: { type: "string" } },
      },
      required: ["course_id"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "canvas_list_announcements",
    description: "Leest announcements",
    inputSchema: {
      type: "object",
      properties: {
        course_ids: { type: "array", items: { type: "string" } },
        start_date: { type: "string" },
        end_date: { type: "string" },
      },
      required: ["course_ids"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "canvas_list_calendar_events",
    description: "Leest agenda-items",
    inputSchema: {
      type: "object",
      properties: {
        course_ids: { type: "array", items: { type: "string" } },
        start_date: { type: "string" },
        end_date: { type: "string" },
      },
      required: ["course_ids"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "canvas_list_modules",
    description: "Leest modules",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "string" },
        search_term: { type: "string" },
      },
      required: ["course_id"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "canvas_get_page",
    description: "Leest pagina",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "string" },
        page_url_or_id: { type: "string" },
      },
      required: ["course_id", "page_url_or_id"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
];

describe("URL normalization and secret scope separation", () => {
  it("normalizes Canvas base URLs and remote MCP URLs safely", () => {
    expect(normalizeCanvasBaseUrl("https://fhict.instructure.com/api/v1/")).toEqual({
      ok: true,
      url: "https://fhict.instructure.com",
      origin: "https://fhict.instructure.com",
    });
    expect(normalizeCanvasBaseUrl("http://fhict.instructure.com").ok).toBe(false);
    expect(normalizeCanvasBaseUrl("https://user:token@fhict.instructure.com").ok).toBe(false);
    expect(normalizeCanvasBaseUrl("https://fhict.instructure.com?foo=bar").ok).toBe(false);

    expect(normalizeRemoteMcpUrl("https://mcp.example.com/mcp/")).toEqual({
      ok: true,
      url: "https://mcp.example.com/mcp",
      origin: "https://mcp.example.com",
    });
  });

  it("keeps Canvas tokens and remote MCP tokens isolated even if the same URL string is used", async () => {
    const secrets = new MemorySecretStore();
    const sharedUrl = "https://shared.example.com";
    await secrets.save(canvasSecretKey(sharedUrl), "canvas-secret-token-111");
    await secrets.save(remoteMcpSecretKey(sharedUrl), "mcp-secret-token-222");

    expect(secrets.resolve(canvasSecretKey(sharedUrl))).toBe("canvas-secret-token-111");
    expect(secrets.resolve(remoteMcpSecretKey(sharedUrl))).toBe("mcp-secret-token-222");
    expect(secrets.resolve(sharedUrl)).toBeUndefined();
  });
});

describe("Capability mapping and read-only tool policy", () => {
  it("maps reviewed read tools and rejects write tools, unknown readOnlyHint tools, and schemas without course boundaries", () => {
    const tools: McpToolDescriptor[] = [
      ...STANDARD_TOOLS,
      // Unknown tool claiming readOnlyHint=true -> must still be blocked
      {
        name: "canvas_export_all_users",
        description: "Leest alle gebruikers",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
      // Write tool -> must be blocked
      {
        name: "canvas_submit_assignment",
        description: "Levert opdracht in",
        inputSchema: { type: "object", properties: { course_id: { type: "string" } } },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      // Reviewed name for assignments, but missing `course_id` boundary -> must be rejected if alone
      {
        name: "list_assignments",
        description: "Ongeldige alias zonder course_id",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
      // Submissions tool with forbidden `student_ids` parameter -> must be rejected
      {
        name: "get_own_submissions",
        description: "Onveilige submissions tool met student_ids",
        inputSchema: {
          type: "object",
          properties: {
            course_id: { type: "string" },
            student_ids: { type: "array" },
          },
        },
        annotations: { readOnlyHint: true },
      },
    ];

    const cap = mapDiscoveredTools(tools);
    expect(Object.keys(cap.mapped)).toHaveLength(7);
    expect(cap.missingOperations).toEqual([]);
    expect(cap.rejectedTools.map((r) => r.name)).toEqual([
      "canvas_export_all_users",
      "canvas_submit_assignment",
      "list_assignments",
      "get_own_submissions",
    ]);
  });
});

describe("HTML-to-plain-text and Canvas payload normalization", () => {
  it("safely strips scripts, styles, and tags while preserving text and bullets", () => {
    const raw = `
      <div class="user_content">
        <script>alert("xss")</script>
        <style>body { display: none; }</style>
        <h2>Week 3 &amp; 4</h2>
        <p>Lever het <strong>architecture document</strong> in vóór vrijdag.</p>
        <ul>
          <li>Onderdeel A &lt;verplicht&gt;</li>
          <li>Onderdeel B</li>
        </ul>
      </div>
    `;
    const text = htmlToPlainText(raw);
    expect(text).not.toContain("alert");
    expect(text).not.toContain("display: none");
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("<strong>");
    expect(text).toContain("Week 3 & 4");
    expect(text).toContain("Lever het architecture document in vóór vrijdag.");
    expect(text).toContain("• Onderdeel A <verplicht>");
  });

  it("preserves missing due dates as null, filters out non-selected courses, and strips disabled categories", () => {
    const coursesMap = new Map([["101", "Software Engineering"]]);
    const origin = "https://fhict.instructure.com";

    // Assignments: due_at, null due_at, past-due published, unpublished draft, other course (999)
    const assignments = normalizeAssignmentsPayload(
      {
        items: [
          {
            id: 1,
            course_id: 101,
            name: "Sprint 1",
            description: "<p>Sprintverslag</p>",
            due_at: "2026-10-25T21:59:00Z",
            published: true,
            html_url: "https://fhict.instructure.com/courses/101/assignments/1",
          },
          {
            id: 2,
            course_id: 101,
            name: "Doorlopend portfolio",
            description: null,
            due_at: null,
            html_url: "https://evil.example.com/phishing",
          },
          {
            id: 4,
            course_id: 101,
            name: "Verlopen portfolio",
            due_at: "2026-10-09T14:00:00Z",
            published: true,
          },
          {
            id: 5,
            course_id: 101,
            name: "Concept-opdracht (niet gepubliceerd)",
            due_at: "2026-10-30T21:59:00Z",
            published: false,
          },
          {
            id: 3,
            course_id: 999,
            name: "Andere cursus",
            due_at: "2026-10-25T21:59:00Z",
          },
        ],
        truncated: true,
        warnings: ["Pagina 2 overgeslagen"],
        retrievedAt: "2026-10-14T15:00:00Z",
      },
      "101",
      coursesMap,
      origin,
    );

    expect(assignments.truncated).toBe(true);
    expect(assignments.warnings).toEqual(["Pagina 2 overgeslagen"]);
    expect(assignments.items).toHaveLength(3);
    expect(assignments.items[0].dueAt).toBe("2026-10-25T21:59:00Z");
    expect(assignments.items[0].text).toBe("Sprintverslag");
    expect(assignments.items[1].dueAt).toBeNull();
    // Phishing cross-origin URL was rejected and replaced with canonical fallback URL
    expect(assignments.items[1].url).toBe("https://fhict.instructure.com/courses/101/assignments/2");
    expect(assignments.items[2].title).toBe("Verlopen portfolio");
    expect(assignments.items[2].dueAt).toBe("2026-10-09T14:00:00Z");
    expect(assignments.items.map((i) => i.title)).not.toContain("Concept-opdracht (niet gepubliceerd)");

    // Calendar events: must strip any assignment event even if returned by a remote server
    const cal = normalizeCalendarEventsPayload(
      [
        {
          id: 900,
          type: "event",
          context_code: "course_101",
          title: "Gastcollege Security",
          start_at: "2026-10-16T09:00:00Z",
          end_at: "2026-10-16T11:00:00Z",
          location_name: "R10-2.14",
        },
        {
          id: "assignment_1",
          type: "assignment",
          context_code: "course_101",
          title: "Verborgen opdracht via agenda",
        },
      ],
      new Set(["101"]),
      coursesMap,
      origin,
    );
    expect(cal.items).toHaveLength(1);
    expect(cal.items[0].title).toBe("Gastcollege Security");
    expect(cal.items[0].text).toContain("Locatie: R10-2.14");

    // Modules: when assignments category is disabled, Assignment & Quiz module items must be stripped
    const mods = normalizeModulesPayload(
      [
        {
          id: 10,
          name: "Week 1",
          items: [
            { id: 1001, title: "Introductiepagina", type: "Page", page_url: "introductie" },
            { id: 1002, title: "Opdracht 1", type: "Assignment" },
            { id: 1003, title: "Kennistest", type: "Quiz" },
          ],
        },
      ],
      "101",
      {
        assignments: false,
        submissions: true,
        announcements: true,
        calendar: true,
        modules: true,
      },
      coursesMap,
      origin,
    );
    expect(mods.items).toHaveLength(1);
    expect(mods.items[0].itemType).toBe("Page");

    // Submissions, announcements, courses, page normalization checks
    const subs = normalizeSubmissionsPayload(
      [{ assignment_id: 1, workflow_state: "submitted", submitted_at: "2026-10-12T10:00:00Z", score: 8.5, grade: "8.5" }],
      "101",
      coursesMap,
      origin,
    );
    expect(subs.items).toHaveLength(1);
    expect(subs.items[0].submitted).toBe(true);
    expect(subs.items[0].score).toBe(8.5);

    const anns = normalizeAnnouncementsPayload(
      [{ id: 77, context_code: "course_101", title: "Roosterwijziging", message: "<p>Lokaal gewijzigd</p>" }],
      new Set(["101"]),
      coursesMap,
      origin,
    );
    expect(anns.items).toHaveLength(1);
    expect(anns.items[0].text).toBe("Lokaal gewijzigd");

    const page = normalizePagePayload(
      { url: "introductie", title: "Welkom", body: "<p>Welkom bij SE</p>" },
      "101",
      "introductie",
      coursesMap,
      origin,
    );
    expect(page.title).toBe("Welkom");
    expect(page.text).toBe("Welkom bij SE");

    const courses = normalizeCoursesPayload(
      [{ id: 101, name: "Software Engineering", course_code: "SE" }],
      origin,
    );
    expect(courses.items[0].id).toBe("101");
  });

  it("handles own submission status accurately: ignores has_submitted_submissions, preserves graded without submitted_at as not submitted, preserves unknown/not_applicable, and never rolls [recurring] deadlines forward", () => {
    const coursesMap = new Map([["16040", "Fontys ICT Open Leeromgeving"]]);
    const origin = "https://fhict.instructure.com";

    // 1. Recurring assignment with past due_at (2026-10-09): must preserve exact due_at and ignore course-wide has_submitted_submissions
    const assignments = normalizeAssignmentsPayload(
      {
        items: [
          {
            id: 401001,
            course_id: 16040,
            name: "Peilmoment en reflectie [recurring]",
            due_at: "2026-10-09T14:00:00Z",
            has_submitted_submissions: true,
            // Even if an upstream payload accidentally included a submission object on an assignment read,
            // normalizeAssignmentsPayload must never leak or infer submission state.
            submission: { workflow_state: "submitted", submitted_at: "2026-10-08T10:00:00Z" },
            html_url: "https://fhict.instructure.com/courses/16040/assignments/401001",
          },
          {
            id: 401002,
            course_id: 16040,
            name: "Portfolio zonder deadline [recurring]",
            due_at: null,
            has_submitted_submissions: true,
          },
        ],
      },
      "16040",
      coursesMap,
      origin,
    );

    expect(assignments.items).toHaveLength(2);
    // Due date is preserved as Oct 9 (never rolled forward to Oct 16)
    expect(assignments.items[0].dueAt).toBe("2026-10-09T14:00:00Z");
    expect(assignments.items[0].assignmentId).toBe("401001");
    expect(assignments.items[0].submitted).toBeUndefined();
    expect(assignments.items[0].submittedAt).toBeNull();
    // Null deadline stays null
    expect(assignments.items[1].dueAt).toBeNull();

    // 2. Submissions:
    // - item A: valid submitted own submission
    // - item B: graded without submitted_at (e.g. 0 points or rubric note without submission) -> submitted MUST be false!
    // - item C: missing/unknown workflow_state -> workflowState MUST be "unknown" (never defaulted to "unsubmitted"!) and submitted undefined
    // - item D: course-wide has_submitted_submissions=true on wrapper, but workflow_state="unsubmitted" -> must remain unsubmitted
    const subs = normalizeSubmissionsPayload(
      {
        enrollmentStatus: "student",
        items: [
          {
            assignment_id: "401001",
            course_id: "16040",
            assignment_name: "Peilmoment en reflectie [recurring]",
            due_at: "2026-10-09T14:00:00Z",
            workflow_state: "submitted",
            submitted_at: "2026-10-09T11:30:00Z",
            late: false,
            missing: false,
          },
          {
            assignment_id: "401002",
            course_id: "16040",
            assignment_name: "Beoordeeld zonder inlevering",
            workflow_state: "graded",
            submitted_at: null,
            score: 0,
            grade: "0",
          },
          {
            assignment_id: "401003",
            course_id: "16040",
            assignment_name: "Geen student-object",
            workflow_state: null,
            submitted_at: null,
          },
          {
            assignment_id: "401004",
            course_id: "16040",
            assignment_name: "Open opdracht",
            has_submitted_submissions: true,
            workflow_state: "unsubmitted",
            submitted_at: null,
            missing: true,
          },
        ],
      },
      "16040",
      coursesMap,
      origin,
    );

    expect(subs.enrollmentStatus).toBe("student");
    expect(subs.items).toHaveLength(4);

    // Item A: joined by courseId + assignmentId, submitted = true
    expect(subs.items[0].id).toBe("canvas:submission:16040:401001");
    expect(subs.items[0].assignmentId).toBe("401001");
    expect(subs.items[0].workflowState).toBe("submitted");
    expect(subs.items[0].submitted).toBe(true);
    expect(subs.items[0].dueAt).toBe("2026-10-09T14:00:00Z");

    // Item B: graded without submitted_at -> submitted is false (not equated with work completed!)
    expect(subs.items[1].workflowState).toBe("graded");
    expect(subs.items[1].submittedAt).toBeNull();
    expect(subs.items[1].submitted).toBe(false);
    expect(subs.items[1].text).toContain("beoordeeld zonder inleverdatum");

    // Item C: missing workflow_state -> preserved as "unknown", never "unsubmitted"
    expect(subs.items[2].workflowState).toBe("unknown");
    expect(subs.items[2].submitted).toBeUndefined();
    expect(subs.items[2].text).toContain("Onbekend / niet van toepassing");

    // Item D: unsubmitted despite has_submitted_submissions=true
    expect(subs.items[3].workflowState).toBe("unsubmitted");
    expect(subs.items[3].submitted).toBe(false);
    expect(subs.items[3].missing).toBe(true);

    // 3. Non-student (TeacherEnrollment) envelope preserves enrollmentStatus and roles
    const teacherSubs = normalizeSubmissionsPayload(
      {
        items: [],
        enrollmentStatus: "not_applicable_non_student",
        enrollmentRoles: ["TeacherEnrollment"],
        warnings: ["Geen StudentEnrollment in cursus 16040."],
      },
      "16040",
      coursesMap,
      origin,
    );
    expect(teacherSubs.items).toHaveLength(0);
    expect(teacherSubs.enrollmentStatus).toBe("not_applicable_non_student");
    expect(teacherSubs.enrollmentRoles).toEqual(["TeacherEnrollment"]);
  });
});

describe("CanvasService permission enforcement, cancellation, and cache invalidation", () => {
  it("distinguishes MCP handshake from Canvas access, blocks disabled categories/courses, and cancels in-flight calls when permissions shrink", async () => {
    const store = new InMemoryDataStore();
    const secrets = new MemorySecretStore();

    let slowAssignmentAborted = false;
    const mockMcp: McpClient = {
      async discover() {
        return {
          serverName: "test-canvas-mcp",
          serverVersion: "1.0.0",
          protocolVersion: "2025-11-25",
          tools: STANDARD_TOOLS,
        };
      },
      async callTool(_target, toolName, _args, signal) {
        if (toolName === "canvas_list_courses") {
          return {
            isError: false,
            structuredContent: {
              items: [
                { id: "101", name: "Software Engineering", course_code: "SE1" },
                { id: "202", name: "Databases", course_code: "DB1" },
              ],
            },
            textContent: "[]",
          };
        }
        if (toolName === "canvas_list_assignments") {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 60);
            signal?.addEventListener("abort", () => {
              clearTimeout(t);
              slowAssignmentAborted = true;
              reject(new CanvasMcpError("aborted", "Geannuleerd"));
            });
          });
          return {
            isError: false,
            structuredContent: {
              items: [{ id: "50", course_id: "101", name: "Huiswerk", due_at: null }],
            },
            textContent: "[]",
          };
        }
        return { isError: false, structuredContent: { items: [] }, textContent: "[]" };
      },
      async disconnect() {},
    };

    const platform: Platform = {
      id: "desktop",
      dataStore: store,
      files: noopFiles,
      secrets,
      http: noopHttp,
      mcp: mockMcp,
      capabilities: { builtInMcp: true },
    };

    const controller = new DataController(platform);
    await controller.load();
    controller.update((d) => {
      d.settings.mcp.mode = "builtin";
      d.settings.canvas.baseUrl = "https://fhict.instructure.com";
      d.settings.canvas.selectedCourseIds = ["101"];
    });

    const service = new CanvasService(controller, mockMcp, secrets, true);

    // Without stored Canvas token -> fails before connecting
    const noTokenSnap = await service.testConnectionAndLoadCourses();
    expect(noTokenSnap.status).toBe("error");
    expect(noTokenSnap.mcpConnected).toBe(false);

    // Save Canvas token under scoped key
    await secrets.save(canvasSecretKey("https://fhict.instructure.com"), "test-canvas-secret");

    const okSnap = await service.testConnectionAndLoadCourses();
    expect(okSnap.status).toBe("verified");
    expect(okSnap.mcpConnected).toBe(true);
    expect(okSnap.canvasAccessVerified).toBe(true);
    expect(okSnap.availableCourses.map((c) => c.id)).toEqual(["101", "202"]);

    // Reading unselected course 202 must be rejected immediately
    await expect(service.listAssignments("202")).rejects.toMatchObject({
      kind: "permission",
    });

    // Start a read for selected course 101 and let it finish to populate held cache
    const loaded = await service.listAssignments("101");
    expect(loaded.items).toHaveLength(1);
    expect(service.getHeldItems("assignments", "101")).not.toBeNull();

    // Start an in-flight read for course 101, then disable the `assignments` category mid-flight
    const inFlightPromise = service.listAssignments("101");
    await new Promise((r) => setTimeout(r, 15));
    controller.update((d) => {
      d.settings.canvas.categories.assignments = false;
    });

    await expect(inFlightPromise).rejects.toMatchObject({
      kind: "aborted",
    });
    expect(slowAssignmentAborted).toBe(true);
    // Held cache for `assignments` must also be invalidated immediately
    expect(service.getHeldItems("assignments", "101")).toBeNull();
  });

  it("never forwards the Canvas token to a remote MCP server in BrowserRemoteMcpClient", async () => {
    const secrets = new MemorySecretStore();
    const remoteUrl = "https://mcp.example.com/mcp";
    // Save a Canvas token under the exact same URL string (in canvas scope)
    await secrets.save(canvasSecretKey(remoteUrl), "SECRET_CANVAS_TOKEN_NEVER_LEAK");

    const seenHeaders: Record<string, string>[] = [];
    const customFetch: typeof fetch = async (_input, init) => {
      const h = new Headers(init?.headers);
      const record: Record<string, string> = {};
      h.forEach((v, k) => {
        record[k.toLowerCase()] = v;
      });
      seenHeaders.push(record);
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new BrowserRemoteMcpClient(secrets, customFetch);
    await client
      .discover({
        mode: "remote",
        endpointUrl: remoteUrl,
        permissions: {
          selectedCourseIds: [],
          categories: {
            assignments: true,
            submissions: true,
            announcements: true,
            calendar: true,
            modules: true,
          },
        },
      })
      .catch(() => undefined);

    const authHeaders = seenHeaders.map((h) => h.authorization).filter(Boolean);
    expect(authHeaders).toEqual([]);
    expect(JSON.stringify(seenHeaders)).not.toContain("SECRET_CANVAS_TOKEN_NEVER_LEAK");
  });
});
