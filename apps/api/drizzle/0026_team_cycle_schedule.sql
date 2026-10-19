ALTER TABLE "teams" ADD COLUMN "cycle_auto_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "cycle_length_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "cycle_start_weekday" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "cycle_upcoming_count" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "timezone" text;