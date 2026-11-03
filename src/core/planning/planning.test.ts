import { describe, expect, it } from "vitest";
import { createDefaultData, migrateAppDataRaw, validateAppData } from "../schema";
import { allocatePlan } from "./allocate";
import { buildFreeSlots } from "./availability";
import {
  addAmsterdamDays,
  amsterdamCivilToUtcInstant,
  amsterdamWeekday,
  amsterdamYmd,
  mondayOfAmsterdamWeek,
} from "./time";
import { validateAllocatedPlan } from "./validate";

describe("planning time (Europe/Amsterdam, DST-safe)", () => {
  it("adds civil days without blindly adding 24h across DST", () => {
    // 2026-03-29 is the spring-forward weekend in NL.
    expect(addAmsterdamDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addAmsterdamDays("2026-03-29", 1)).toBe("2026-03-30");
    expect(amsterdamWeekday("2026-10-19")).toBe("ma");
    expect(mondayOfAmsterdamWeek("2026-10-22")).toBe("2026-10-19");
  });

  it("round-trips civil Amsterdam local time around autumn DST", () => {
    const before = amsterdamCivilToUtcInstant("2026-10-25", "01:30");
    const after = amsterdamCivilToUtcInstant("2026-10-25", "03:30");
    expect(amsterdamYmd(before)).toBe("2026-10-25");
    expect(amsterdamYmd(after)).toBe("2026-10-25");
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });
});

describe("allocator / validator", () => {
  const profile = createDefaultData(true).profile;

  it("schedules within availability, outside commitments, from now", () => {
    // Monday 2026-10-19 10:00 Amsterdam
    const now = amsterdamCivilToUtcInstant("2026-10-19", "10:00");
    profile.dayWindows.ma = { start: "09:00", end: "17:00" };
    profile.availableStudyHours.ma = 8;
    profile.fixedCommitments = [
      { id: "c1", day: "ma", start: "12:00", end: "13:00", description: "Lunchcollege" },
    ];
    profile.preferredBlockMinutes = 60;
    profile.breakMinutes = 10;

    const result = allocatePlan({
      profile,
      scope: "dag",
      startDate: "2026-10-19",
      now,
      tasks: [
        {
          id: "a1",
          title: "Portfolio",
          remainingMinutes: 90,
          priority: "hoog",
          dueAt: "2026-10-19T21:59:00Z",
          origin: "canvas",
          sourceRef: "canvas:assignment:101:1",
        },
      ],
    });

    expect(result.blocks.some((b) => b.start < "10:00")).toBe(false);
    expect(result.blocks.some((b) => b.start >= "12:00" && b.start < "13:00")).toBe(false);
    expect(result.status).toBe("complete");
    const issues = validateAllocatedPlan({
      plan: {
        scope: "dag",
        startDate: "2026-10-19",
        blocks: result.blocks,
        unscheduled: result.unscheduled,
        status: result.status,
        oneOffConstraints: [],
      },
      profile,
      now,
    });
    expect(issues).toEqual([]);
  });

  it("returns partial plan with shortfall instead of extending hours past deadline", () => {
    const now = amsterdamCivilToUtcInstant("2026-10-19", "16:00");
    profile.dayWindows.ma = { start: "09:00", end: "17:00" };
    profile.availableStudyHours.ma = 8;
    profile.fixedCommitments = [];

    const result = allocatePlan({
      profile,
      scope: "dag",
      startDate: "2026-10-19",
      now,
      tasks: [
        {
          id: "big",
          title: "Grote opdracht",
          remainingMinutes: 180,
          priority: "hoog",
          dueAt: "2026-10-19T21:59:00Z",
          origin: "canvas",
          sourceRef: "src",
        },
      ],
    });

    expect(result.status).toBe("partial");
    expect(result.capacityShortfallMinutes).toBeGreaterThan(0);
    expect(result.unscheduled[0]?.title).toBe("Grote opdracht");
    expect(result.blocks.every((b) => b.end <= "17:00")).toBe(true);
  });

  it("does not schedule completed own tasks unless requested", () => {
    const now = amsterdamCivilToUtcInstant("2026-10-19", "09:00");
    const result = allocatePlan({
      profile,
      scope: "dag",
      startDate: "2026-10-19",
      now,
      tasks: [
        {
          id: "done",
          title: "Klaar",
          remainingMinutes: 60,
          priority: "hoog",
          dueAt: null,
          origin: "student",
          sourceRef: null,
          done: true,
        },
      ],
    });
    expect(result.blocks.filter((b) => !b.isBreak)).toHaveLength(0);
  });

  it("keeps overdue work visible as unscheduled when no capacity before deadline", () => {
    const now = amsterdamCivilToUtcInstant("2026-10-20", "10:00");
    const result = allocatePlan({
      profile,
      scope: "dag",
      startDate: "2026-10-20",
      now,
      tasks: [
        {
          id: "late",
          title: "Verlopen",
          remainingMinutes: 60,
          priority: "hoog",
          dueAt: "2026-10-09T14:00:00Z",
          origin: "canvas",
          sourceRef: "src",
        },
      ],
    });
    expect(result.warnings.some((w) => w.includes("verstreken"))).toBe(true);
    expect(result.unscheduled.some((u) => u.id === "late")).toBe(true);
  });

  it("one-off unavailable date removes slots without changing profile windows", () => {
    const now = amsterdamCivilToUtcInstant("2026-10-19", "08:00");
    const free = buildFreeSlots({
      profile,
      scope: "week",
      startDate: "2026-10-19",
      now,
      oneOffUnavailableDates: ["2026-10-21"],
    });
    expect(free.some((s) => s.date === "2026-10-21")).toBe(false);
    expect(profile.dayWindows.wo).not.toBeNull();
  });
});

describe("schema migration v1 → v2", () => {
  it("migrates v1 documents and keeps own tasks / plans", () => {
    const v1 = {
      schema: "plums",
      version: 1,
      settings: createDefaultData(true).settings,
      profile: {
        name: "Ada",
        studyContext: "ICT",
        availableStudyHours: { ma: 4, di: 4, wo: 4, do: 4, vr: 4, za: 0, zo: 0 },
        fixedCommitments: [],
        preferredBlockMinutes: 50,
      },
      conversations: [],
      ownTasks: [
        {
          id: "t1",
          title: "Essay",
          notes: "",
          dueAt: null,
          estimateMinutes: 120,
          done: false,
          createdAt: "2026-10-01T00:00:00.000Z",
        },
      ],
      plans: [
        {
          id: "p1",
          title: "Week",
          scope: "week",
          startDate: "2026-10-19",
          conversationId: null,
          createdAt: "2026-10-15T00:00:00.000Z",
          updatedAt: "2026-10-15T00:00:00.000Z",
          blocks: [],
        },
      ],
    };
    const migrated = migrateAppDataRaw(structuredClone(v1) as Record<string, unknown>);
    expect(migrated.version).toBe(2);
    const result = validateAppData(v1, true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.version).toBe(2);
      expect(result.data.profile.dayWindows.ma).toEqual({ start: "09:00", end: "13:00" });
      expect(result.data.ownTasks[0].priority).toBe("middel");
      expect(result.data.plans[0].status).toBe("complete");
      expect(result.data.plans[0].revision).toBe(1);
    }
  });
});
