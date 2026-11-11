import { db } from "~/db";
import {
  coupons,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refundRequests,
  videoWatchEvents,
  LessonProgressStatus,
  RefundRequestStatus,
} from "~/db/schema";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

export const REFUND_WINDOW_DAYS = 14;
const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
const REFUND_COMPLETION_LIMIT = 0.5;

export type RefundIneligibleReason =
  | "already_pending"
  | "outside_refund_window"
  | "watched_too_much"
  | "claimed_team_seat";

export type RefundEligibility =
  | { eligible: true; amount: number; lastDayInWindow: string }
  | { eligible: false; reason: RefundIneligibleReason };

// Compare whole days, not hours — a purchase at 23:00 should still get its
// full fourteenth day.
function asDayString(when: Date) {
  const year = when.getFullYear();
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getCourseLessonIds(courseId: number) {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

function getSecondsWatched(userId: number, lessonIds: number[]) {
  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return furthestPerLesson.reduce((total, row) => total + row.furthest, 0);
}

function hasWatchedTooMuch(userId: number, courseId: number) {
  const lessonIds = getCourseLessonIds(courseId);
  if (lessonIds.length === 0) return false;

  const completedCount = getCompletedLessonCount(userId, lessonIds);
  if (completedCount / lessonIds.length >= REFUND_COMPLETION_LIMIT) return true;

  return getSecondsWatched(userId, lessonIds) >= REFUND_WATCH_LIMIT_SECONDS;
}

function hasPendingRefundRequest(purchaseId: number) {
  const pending = db
    .select({ id: refundRequests.id })
    .from(refundRequests)
    .where(
      and(
        eq(refundRequests.purchaseId, purchaseId),
        eq(refundRequests.status, RefundRequestStatus.Pending)
      )
    )
    .get();

  return pending !== undefined;
}

// A seat that came out of a team licence, and has been claimed, belongs to
// the team — the buyer cannot hand it back on their own.
function hasClaimedTeamSeat(purchaseId: number) {
  const claimedSeat = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
    )
    .get();

  return claimedSeat !== undefined;
}

/**
 * Whether the learner may raise a Refund Request for this Purchase right now.
 * The single source of Refund Eligibility.
 */
export function getRefundEligibility(purchaseId: number): RefundEligibility {
  const purchase = db
    .select()
    .from(purchases)
    .where(eq(purchases.id, purchaseId))
    .get();

  if (!purchase) throw new Error(`Purchase ${purchaseId} not found`);

  if (hasPendingRefundRequest(purchase.id)) {
    return { eligible: false, reason: "already_pending" };
  }

  const windowEnd = new Date(purchase.createdAt);
  windowEnd.setDate(windowEnd.getDate() + REFUND_WINDOW_DAYS);
  const lastDayInWindow = asDayString(windowEnd);
  const purchasedDay = asDayString(new Date(purchase.createdAt));
  const todayDay = asDayString(new Date());

  if (todayDay < purchasedDay || todayDay > lastDayInWindow) {
    return { eligible: false, reason: "outside_refund_window" };
  }

  if (hasWatchedTooMuch(purchase.userId, purchase.courseId)) {
    return { eligible: false, reason: "watched_too_much" };
  }

  if (hasClaimedTeamSeat(purchase.id)) {
    return { eligible: false, reason: "claimed_team_seat" };
  }

  return { eligible: true, amount: purchase.amountPaid, lastDayInWindow };
}
