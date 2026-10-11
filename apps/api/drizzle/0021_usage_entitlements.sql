CREATE TYPE "public"."workspace_plan" AS ENUM('free', 'team', 'self_host_unlimited');--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"day" text NOT NULL,
	"seats" integer DEFAULT 0 NOT NULL,
	"agents" integer DEFAULT 0 NOT NULL,
	"agent_runs" integer DEFAULT 0 NOT NULL,
	"api_calls" bigint DEFAULT 0 NOT NULL,
	"storage_bytes" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_daily_workspace_id_day_unique" UNIQUE("workspace_id","day")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "plan" "workspace_plan" DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;