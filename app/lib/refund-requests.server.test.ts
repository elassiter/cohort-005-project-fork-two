import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import { createTestDb, seedBaseData } from "~/test/setup";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import { getRefundEligibility } from "./refund-requests.server";

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
  status: schema.RefundRequestStatus
) {
  testDb
    .insert(schema.refundRequests)
    .values({ purchaseId, status, reason: "It was not what I expected." })
    .run();
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
