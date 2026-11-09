CREATE TABLE "glitchtip_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"base_url" text NOT NULL,
	"token_enc" text NOT NULL,
	"token_last4" text NOT NULL,
	"last_status" text,
	"last_checked_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "glitchtip_connections_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
CREATE TABLE "glitchtip_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"glitchtip_id" text NOT NULL,
	"short_id" text,
	"title" text NOT NULL,
	"culprit" text,
	"level" text DEFAULT 'error' NOT NULL,
	"status" text DEFAULT 'unresolved' NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"user_count" integer DEFAULT 0 NOT NULL,
	"first_seen" timestamp with time zone,
	"last_seen" timestamp with time zone,
	"link" text NOT NULL,
	"latest_event" jsonb,
	"latest_event_at" timestamp with time zone,
	"ticket_issue_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "glitchtip_issues_project_id_glitchtip_id_unique" UNIQUE("project_id","glitchtip_id")
);
--> statement-breakpoint
CREATE TABLE "glitchtip_project_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"org_slug" text NOT NULL,
	"project_slug" text NOT NULL,
	"last_status" text,
	"last_synced_at" timestamp with time zone,
	"backoff_until" timestamp with time zone,
	"open_count" integer DEFAULT 0 NOT NULL,
	"open_capped" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "glitchtip_project_links_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
ALTER TABLE "glitchtip_connections" ADD CONSTRAINT "glitchtip_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glitchtip_connections" ADD CONSTRAINT "glitchtip_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glitchtip_issues" ADD CONSTRAINT "glitchtip_issues_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glitchtip_issues" ADD CONSTRAINT "glitchtip_issues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glitchtip_issues" ADD CONSTRAINT "glitchtip_issues_ticket_issue_id_issues_id_fk" FOREIGN KEY ("ticket_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glitchtip_project_links" ADD CONSTRAINT "glitchtip_project_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glitchtip_project_links" ADD CONSTRAINT "glitchtip_project_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "glitchtip_issues_workspace_id_project_id_last_seen_index" ON "glitchtip_issues" USING btree ("workspace_id","project_id","last_seen");--> statement-breakpoint
CREATE INDEX "glitchtip_project_links_workspace_id_index" ON "glitchtip_project_links" USING btree ("workspace_id");