CREATE TABLE "intake_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"team_id" uuid,
	"label" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_last4" text NOT NULL,
	"reporter_notify_email" text,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_credentials_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "intake_credentials" ADD CONSTRAINT "intake_credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_credentials" ADD CONSTRAINT "intake_credentials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_credentials" ADD CONSTRAINT "intake_credentials_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_credentials" ADD CONSTRAINT "intake_credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intake_credentials_workspace_id_index" ON "intake_credentials" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "intake_credentials_workspace_id_project_id_index" ON "intake_credentials" USING btree ("workspace_id","project_id");