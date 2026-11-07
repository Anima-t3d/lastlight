CREATE TABLE `usage_gate_overrides` (
	`name` text PRIMARY KEY NOT NULL,
	`enabled` integer,
	`max_percent` integer,
	`updated_by` text,
	`updated_at` text NOT NULL
);
