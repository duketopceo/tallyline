ALTER TYPE "public"."issue_source" ADD VALUE 'intake';--> statement-breakpoint
CREATE TABLE "intake_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"endpoint_id" uuid,
	"provider" text NOT NULL,
	"external_id" text,
	"fingerprint" text,
	"issue_id" uuid,
	"status" text DEFAULT 'accepted' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "intake_fingerprint" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "triage_suggestion" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "occurrence_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "intake_events" ADD CONSTRAINT "intake_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_events" ADD CONSTRAINT "intake_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intake_events_workspace_id_issue_id_index" ON "intake_events" USING btree ("workspace_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_events_delivery_unique" ON "intake_events" USING btree ("workspace_id","provider","external_id") WHERE "intake_events"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "issues_intake_fingerprint_index" ON "issues" USING btree ("workspace_id","intake_fingerprint") WHERE "issues"."intake_fingerprint" is not null;