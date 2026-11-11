import { Link, isRouteErrorResponse, useSearchParams } from "react-router";
import type { Route } from "./+types/admin.refund-requests";
import { RefundRequestStatus } from "~/db/schema";
import { requireAdmin } from "~/lib/access.server";
import {
  countPendingRefundRequests,
  listRefundRequests,
  type RefundIneligibleReason,
  type RefundRequestRow,
} from "~/lib/refund-requests.server";
import { formatPrice } from "~/lib/utils";
import { Card, CardContent } from "~/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { AlertTriangle, ReceiptText } from "lucide-react";

const TABS = [
  { status: RefundRequestStatus.Pending, label: "Pending" },
  { status: RefundRequestStatus.Approved, label: "Approved" },
  { status: RefundRequestStatus.Declined, label: "Declined" },
] as const;

function parseStatus(value: string | null): RefundRequestStatus {
  const tab = TABS.find((t) => t.status === value);
  return tab ? tab.status : RefundRequestStatus.Pending;
}

const WARNING_MESSAGES: Record<RefundIneligibleReason, string> = {
  watched_too_much:
    "No longer eligible: the learner has since watched too much of the course.",
  claimed_team_seat:
    "No longer eligible: a team seat from this purchase has since been claimed.",
  outside_refund_window:
    "No longer eligible: the purchase is outside the Refund Window.",
  already_pending: "No longer eligible: another Refund Request is Pending.",
};

const EMPTY_MESSAGES: Record<RefundRequestStatus, string> = {
  [RefundRequestStatus.Pending]: "No Refund Requests are waiting for a decision.",
  [RefundRequestStatus.Approved]: "No Refund Requests have been Approved yet.",
  [RefundRequestStatus.Declined]: "No Refund Requests have been Declined yet.",
};

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Approve or Decline Refund Requests" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);

  const status = parseStatus(new URL(request.url).searchParams.get("status"));

  return {
    status,
    refundRequests: listRefundRequests(status),
    pendingCount: countPendingRefundRequests(),
  };
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

// The slot for Approve and Decline. Decisions are final, so only Pending
// requests will ever get controls here.
function RefundRequestActions({
  refundRequest,
}: {
  refundRequest: RefundRequestRow;
}) {
  if (refundRequest.status !== RefundRequestStatus.Pending) return null;
  return <div className="flex items-center gap-2" />;
}

function DecisionDetails({ refundRequest }: { refundRequest: RefundRequestRow }) {
  if (refundRequest.status === RefundRequestStatus.Pending) return null;

  const verb =
    refundRequest.status === RefundRequestStatus.Approved
      ? "Approved"
      : "Declined";

  return (
    <div className="mt-4 rounded-md border border-border bg-muted/40 p-3 text-sm">
      <p>
        {verb} by {refundRequest.decidedBy?.name ?? "an unknown Admin"}
        {refundRequest.decidedAt && (
          <> on {formatDateTime(refundRequest.decidedAt)}</>
        )}
      </p>
      {refundRequest.declineReason && (
        <p className="mt-2 whitespace-pre-wrap text-muted-foreground">
          <span className="font-medium text-foreground">Decline Reason: </span>
          {refundRequest.declineReason}
        </p>
      )}
    </div>
  );
}

function RefundRequestCard({ refundRequest }: { refundRequest: RefundRequestRow }) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="font-medium">{refundRequest.learner.name}</p>
            <p className="text-sm text-muted-foreground">
              {refundRequest.learner.email}
            </p>
          </div>
          <RefundRequestActions refundRequest={refundRequest} />
        </div>

        {refundRequest.warning && (
          <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{WARNING_MESSAGES[refundRequest.warning]}</span>
          </div>
        )}

        <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
          <Detail label="Course">
            <Link
              to={`/courses/${refundRequest.course.slug}`}
              className="hover:underline"
            >
              {refundRequest.course.title}
            </Link>
          </Detail>
          <Detail label="Amount paid">
            {formatPrice(refundRequest.amountPaid)}
          </Detail>
          <Detail label="Purchased">{formatDate(refundRequest.purchasedAt)}</Detail>
          <Detail label="Requested">{formatDate(refundRequest.requestedAt)}</Detail>
          <Detail label="Completed">{refundRequest.completionPercent}%</Detail>
        </dl>

        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Learner's reason
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm">
            {refundRequest.reason}
          </p>
        </div>

        <DecisionDetails refundRequest={refundRequest} />
      </CardContent>
    </Card>
  );
}

export default function AdminRefundRequests({ loaderData }: Route.ComponentProps) {
  const { status, refundRequests, pendingCount } = loaderData;
  const [, setSearchParams] = useSearchParams();

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refund Requests</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Approve or Decline learners' Refund Requests
        </p>
      </div>

      <Tabs
        value={status}
        onValueChange={(value) => setSearchParams({ status: value })}
        className="mb-6"
      >
        <TabsList>
          {TABS.map((tab) => (
            <TabsTrigger key={tab.status} value={tab.status}>
              {tab.label}
              {tab.status === RefundRequestStatus.Pending && pendingCount > 0 && (
                <span className="ml-1.5 rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
                  {pendingCount}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {refundRequests.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <ReceiptText className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="text-muted-foreground">{EMPTY_MESSAGES[status]}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {refundRequests.map((refundRequest) => (
            <RefundRequestCard
              key={refundRequest.id}
              refundRequest={refundRequest}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading Refund Requests.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message =
        typeof error.data === "string"
          ? error.data
          : "Only admins can access this page.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link
          to="/"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
