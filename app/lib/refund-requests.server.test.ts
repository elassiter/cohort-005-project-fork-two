import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import { createTestDb, seedBaseData } from "~/test/setup";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import {
  countPendingRefundRequests,
  getRefundEligibility,
  listRefundRequests,
} from "./refund-requests.server";

let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
});

afterEach(() => {
  vi.useRealTimers();
});

function today(when: Date) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(when);
}

function buyCourse(purchasedAt: Date, amountPaid = 4900) {
  return testDb
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid,
      createdAt: purchasedAt.toISOString(),
    })
    .returning()
    .get();
}

function addLessons(count: number) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module 1", position: 1 })
    .returning()
    .get();

  return Array.from({ length: count }, (_, i) =>
    testDb
      .insert(schema.lessons)
      .values({ moduleId: mod.id, title: `Lesson ${i + 1}`, position: i + 1 })
      .returning()
      .get()
  );
}

function watchUpTo(lessonId: number, positionSeconds: number) {
  testDb
    .insert(schema.videoWatchEvents)
    .values({
      userId: base.user.id,
      lessonId,
      eventType: "progress",
      positionSeconds,
    })
    .run();
}

function completeLesson(lessonId: number) {
  testDb
    .insert(schema.lessonProgress)
    .values({
      userId: base.user.id,
      lessonId,
      status: schema.LessonProgressStatus.Completed,
    })
    .run();
}

function addSeat(
  purchaseId: number,
  code: string,
  { claimedBy }: { claimedBy?: number } = {}
) {
  const team = testDb.insert(schema.teams).values({}).returning().get();
  testDb
    .insert(schema.coupons)
    .values({
      teamId: team.id,
      courseId: base.course.id,
      code,
      purchaseId,
      redeemedByUserId: claimedBy ?? null,
      redeemedAt: claimedBy ? new Date(2026, 0, 1).toISOString() : null,
    })
    .run();
}

function raiseRefundRequest(
  purchaseId: number,
  status: schema.RefundRequestStatus,
  extra: Partial<typeof schema.refundRequests.$inferInsert> = {}
) {
  return testDb
    .insert(schema.refundRequests)
    .values({
      purchaseId,
      status,
      reason: "It was not what I expected.",
      ...extra,
    })
    .returning()
    .get();
}

describe("getRefundEligibility", () => {
  it("is eligible inside the Refund Window", () => {
    const purchase = buyCourse(new Date(2026, 0, 1, 23, 0));
    today(new Date(2026, 0, 5, 9, 0));

    expect(getRefundEligibility(purchase.id)).toEqual({
      eligible: true,
      amount: 4900,
      lastDayInWindow: "2026-01-15",
    });
  });

  it("is still eligible on the last day of the Refund Window", () => {
    const purchase = buyCourse(new Date(2026, 0, 1, 23, 0));
    today(new Date(2026, 0, 15, 23, 59));

    expect(getRefundEligibility(purchase.id)).toMatchObject({ eligible: true });
  });

  it("is not eligible the day after the Refund Window closes", () => {
    const purchase = buyCourse(new Date(2026, 0, 1, 23, 0));
    today(new Date(2026, 0, 16, 0, 1));

    expect(getRefundEligibility(purchase.id)).toEqual({
      eligible: false,
      reason: "outside_refund_window",
    });
  });

  it("is not eligible after watching two hours of the course", () => {
    const [first, second] = addLessons(4);
    watchUpTo(first.id, 60 * 60);
    watchUpTo(second.id, 60 * 60);
    const purchase = buyCourse(new Date(2026, 0, 1));
    today(new Date(2026, 0, 2));

    expect(getRefundEligibility(purchase.id)).toEqual({
      eligible: false,
      reason: "watched_too_much",
    });
  });

  it("is not eligible after completing half the lessons", () => {
    const [first, second] = addLessons(4);
    completeLesson(first.id);
    completeLesson(second.id);
    const purchase = buyCourse(new Date(2026, 0, 1));
    today(new Date(2026, 0, 2));

    expect(getRefundEligibility(purchase.id)).toEqual({
      eligible: false,
      reason: "watched_too_much",
    });
  });

  it("stays eligible after watching a little of the course", () => {
    const [first] = addLessons(4);
    watchUpTo(first.id, 60 * 60);
    completeLesson(first.id);
    const purchase = buyCourse(new Date(2026, 0, 1));
    today(new Date(2026, 0, 2));

    expect(getRefundEligibility(purchase.id)).toMatchObject({ eligible: true });
  });

  it("is not eligible once a team seat from the Purchase is claimed", () => {
    const purchase = buyCourse(new Date(2026, 0, 1));
    addSeat(purchase.id, "SEAT-OPEN");
    addSeat(purchase.id, "SEAT-CLAIMED", { claimedBy: base.instructor.id });
    today(new Date(2026, 0, 2));

    expect(getRefundEligibility(purchase.id)).toEqual({
      eligible: false,
      reason: "claimed_team_seat",
    });
  });

  it("stays eligible while every team seat is unclaimed", () => {
    const purchase = buyCourse(new Date(2026, 0, 1));
    addSeat(purchase.id, "SEAT-OPEN");
    today(new Date(2026, 0, 2));

    expect(getRefundEligibility(purchase.id)).toMatchObject({ eligible: true });
  });

  it("is not eligible while a Refund Request is already Pending", () => {
    const purchase = buyCourse(new Date(2026, 0, 1));
    raiseRefundRequest(purchase.id, schema.RefundRequestStatus.Pending);
    today(new Date(2026, 0, 2));

    expect(getRefundEligibility(purchase.id)).toEqual({
      eligible: false,
      reason: "already_pending",
    });
  });

  it("is eligible again after a Refund Request is Declined", () => {
    const purchase = buyCourse(new Date(2026, 0, 1));
    raiseRefundRequest(purchase.id, schema.RefundRequestStatus.Declined);
    today(new Date(2026, 0, 2));

    expect(getRefundEligibility(purchase.id)).toMatchObject({ eligible: true });
  });
});

describe("listRefundRequests", () => {
  it("lists only Pending Refund Requests with what an Admin needs to decide", () => {
    const [first] = addLessons(4);
    completeLesson(first.id);
    const purchase = buyCourse(new Date(2026, 0, 1, 10, 0), 4900);
    const request = raiseRefundRequest(
      purchase.id,
      schema.RefundRequestStatus.Pending,
      { requestedAt: new Date(2026, 0, 3, 9, 0).toISOString() }
    );
    raiseRefundRequest(purchase.id, schema.RefundRequestStatus.Declined);
    today(new Date(2026, 0, 4));

    expect(listRefundRequests(schema.RefundRequestStatus.Pending)).toEqual([
      {
        id: request.id,
        status: schema.RefundRequestStatus.Pending,
        learner: {
          id: base.user.id,
          name: "Test User",
          email: "test@example.com",
        },
        course: {
          id: base.course.id,
          title: "Test Course",
          slug: "test-course",
        },
        purchaseId: purchase.id,
        amountPaid: 4900,
        purchasedAt: new Date(2026, 0, 1, 10, 0).toISOString(),
        requestedAt: new Date(2026, 0, 3, 9, 0).toISOString(),
        completionPercent: 25,
        reason: "It was not what I expected.",
        decidedAt: null,
        decidedBy: null,
        declineReason: null,
        warning: null,
      },
    ]);
  });

  it("lists Declined Refund Requests with who Declined them, when and why", () => {
    const admin = testDb
      .insert(schema.users)
      .values({
        name: "Test Admin",
        email: "admin@example.com",
        role: schema.UserRole.Admin,
      })
      .returning()
      .get();
    const purchase = buyCourse(new Date(2026, 0, 1));
    raiseRefundRequest(purchase.id, schema.RefundRequestStatus.Pending);
    raiseRefundRequest(purchase.id, schema.RefundRequestStatus.Approved, {
      decidedAt: new Date(2026, 0, 2).toISOString(),
      decidedByUserId: admin.id,
    });
    const declined = raiseRefundRequest(
      purchase.id,
      schema.RefundRequestStatus.Declined,
      {
        decidedAt: new Date(2026, 0, 3).toISOString(),
        decidedByUserId: admin.id,
        declineReason: "You have finished the course.",
      }
    );

    expect(listRefundRequests(schema.RefundRequestStatus.Declined)).toEqual([
      expect.objectContaining({
        id: declined.id,
        status: schema.RefundRequestStatus.Declined,
        decidedAt: new Date(2026, 0, 3).toISOString(),
        decidedBy: { id: admin.id, name: "Test Admin" },
        declineReason: "You have finished the course.",
        warning: null,
      }),
    ]);
  });

  it("warns on a Pending request when the learner has since watched too much", () => {
    const [first, second] = addLessons(4);
    const purchase = buyCourse(new Date(2026, 0, 1));
    raiseRefundRequest(purchase.id, schema.RefundRequestStatus.Pending);
    completeLesson(first.id);
    completeLesson(second.id);
    today(new Date(2026, 0, 2));

    expect(listRefundRequests(schema.RefundRequestStatus.Pending)).toEqual([
      expect.objectContaining({ warning: "watched_too_much" }),
    ]);
  });

  it("warns on a Pending request when a team seat has since been claimed", () => {
    const purchase = buyCourse(new Date(2026, 0, 1));
    raiseRefundRequest(purchase.id, schema.RefundRequestStatus.Pending);
    addSeat(purchase.id, "SEAT-CLAIMED", { claimedBy: base.instructor.id });
    today(new Date(2026, 0, 2));

    expect(listRefundRequests(schema.RefundRequestStatus.Pending)).toEqual([
      expect.objectContaining({ warning: "claimed_team_seat" }),
    ]);
  });

  it("does not warn when a Pending request has waited past the Refund Window", () => {
    const purchase = buyCourse(new Date(2026, 0, 1));
    raiseRefundRequest(purchase.id, schema.RefundRequestStatus.Pending, {
      requestedAt: new Date(2026, 0, 10).toISOString(),
    });
    today(new Date(2026, 1, 1));

    expect(listRefundRequests(schema.RefundRequestStatus.Pending)).toEqual([
      expect.objectContaining({ warning: null }),
    ]);
  });
});

describe("countPendingRefundRequests", () => {
  it("counts only Pending Refund Requests", () => {
    const purchase = buyCourse(new Date(2026, 0, 1));
    raiseRefundRequest(purchase.id, schema.RefundRequestStatus.Pending);
    raiseRefundRequest(purchase.id, schema.RefundRequestStatus.Pending);
    raiseRefundRequest(purchase.id, schema.RefundRequestStatus.Approved);
    raiseRefundRequest(purchase.id, schema.RefundRequestStatus.Declined);

    expect(countPendingRefundRequests()).toBe(2);
  });

  it("is zero when nothing is Pending", () => {
    expect(countPendingRefundRequests()).toBe(0);
  });
});
