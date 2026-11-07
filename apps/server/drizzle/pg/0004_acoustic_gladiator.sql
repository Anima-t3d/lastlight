CREATE TABLE "usage_gate_overrides" (
	"name" text PRIMARY KEY NOT NULL,
	"enabled" boolean,
	"max_percent" integer,
	"updated_by" text,
	"updated_at" text NOT NULL
);
