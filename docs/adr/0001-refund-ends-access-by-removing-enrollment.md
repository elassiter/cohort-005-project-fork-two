# A Refund ends access by removing the enrollment; Refunded Purchase is derived

When a Refund Request is Approved we delete the learner's enrollment for that course rather than marking it, and we do not add a "refunded" flag to the Purchase. A Purchase is a Refunded Purchase because it has an Approved Refund Request. Access already means "has an enrollment" everywhere, so removing it ends access with no new checks, and deriving the refunded state from the Refund Request keeps one source of truth. Lesson progress is kept, so a learner who buys again (a new Purchase and enrollment) picks up where they left off.

## Considered Options

- A status on the enrollment (e.g. active/refunded): every access check would need to learn about it.
- A refunded flag or date on the Purchase: duplicates what the Approved Refund Request already says, and the two could disagree.
