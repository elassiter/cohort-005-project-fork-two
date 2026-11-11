ALTER TABLE `refund_requests` RENAME COLUMN `resolved_at` TO `decided_at`;
--> statement-breakpoint
ALTER TABLE `refund_requests` RENAME COLUMN `resolved_by_user_id` TO `decided_by_user_id`;
--> statement-breakpoint
ALTER TABLE `refund_requests` ADD `decline_reason` text;