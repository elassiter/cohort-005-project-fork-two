import { db } from "~/db";
import { alias } from "drizzle-orm/sqlite-core";
import {
  coupons,
  courses,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refundRequests,
  users,
  videoWatchEvents,
  LessonProgressStatus,
  RefundRequestStatus,
} from "~/db/schema";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

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

export type RefundRequestRow = {
  id: number;
  status: RefundRequestStatus;
  learner: { id: number; name: string; email: string };
  course: { id: number; title: string; slug: string };
  purchaseId: number;
  amountPaid: number;
  purchasedAt: string;
  requestedAt: string;
  /** Whole-number percentage of the course's lessons the learner has completed. */
  completionPercent: number;
  reason: string;
  decidedAt: string | null;
  decidedBy: { id: number; name: string } | null;
  declineReason: string | null;
  /**
   * Set on a Pending request that no longer meets Refund Eligibility, judged
   * on current facts. Always null on decided requests.
   */
  warning: RefundIneligibleReason | null;
};

function getCompletionPercent(userId: number, courseId: number) {
  const lessonIds = getCourseLessonIds(courseId);
  if (lessonIds.length === 0) return 0;
  const completed = getCompletedLessonCount(userId, lessonIds);
  return Math.round((completed / lessonIds.length) * 100);
}

// Re-checks Refund Eligibility for a request already raised. The Refund Window
// and the already-Pending rule are left out: the learner met the first when
// they asked, and the second is the request itself.
function getPendingWarning(
  purchaseId: number,
  userId: number,
  courseId: number
): RefundIneligibleReason | null {
  if (hasWatchedTooMuch(userId, courseId)) return "watched_too_much";
  if (hasClaimedTeamSeat(purchaseId)) return "claimed_team_seat";
  return null;
}

/**
 * The Refund Requests in one tab of the admin Refund Requests page. Pending
 * requests come oldest first; decided ones most recently decided first.
 */
export function listRefundRequests(
  status: RefundRequestStatus
): RefundRequestRow[] {
  const decider = alias(users, "decider");

  const rows = db
    .select({
      id: refundRequests.id,
      status: refundRequests.status,
      reason: refundRequests.reason,
      requestedAt: refundRequests.requestedAt,
      decidedAt: refundRequests.decidedAt,
      declineReason: refundRequests.declineReason,
      purchaseId: purchases.id,
      amountPaid: purchases.amountPaid,
      purchasedAt: purchases.createdAt,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      deciderId: decider.id,
      deciderName: decider.name,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .leftJoin(decider, eq(refundRequests.decidedByUserId, decider.id))
    .where(eq(refundRequests.status, status))
    .orderBy(
      status === RefundRequestStatus.Pending
        ? asc(refundRequests.requestedAt)
        : desc(refundRequests.decidedAt),
      asc(refundRequests.id)
    )
    .all();

  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    learner: { id: row.learnerId, name: row.learnerName, email: row.learnerEmail },
    course: { id: row.courseId, title: row.courseTitle, slug: row.courseSlug },
    purchaseId: row.purchaseId,
    amountPaid: row.amountPaid,
    purchasedAt: row.purchasedAt,
    requestedAt: row.requestedAt,
    completionPercent: getCompletionPercent(row.learnerId, row.courseId),
    reason: row.reason,
    decidedAt: row.decidedAt,
    decidedBy:
      row.deciderId !== null && row.deciderName !== null
        ? { id: row.deciderId, name: row.deciderName }
        : null,
    declineReason: row.declineReason,
    warning:
      row.status === RefundRequestStatus.Pending
        ? getPendingWarning(row.purchaseId, row.learnerId, row.courseId)
        : null,
  }));
}

/** How many Refund Requests are waiting for an Admin's decision. */
export function countPendingRefundRequests(): number {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(refundRequests)
    .where(eq(refundRequests.status, RefundRequestStatus.Pending))
    .get();

  return result?.count ?? 0;
}
