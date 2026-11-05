ALTER TYPE "public"."provider_type" ADD VALUE IF NOT EXISTS 'apple';--> statement-breakpoint
CREATE TABLE "issue_key_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_key_aliases_workspace_id_key_unique" UNIQUE("workspace_id","key")
);
--> statement-breakpoint
ALTER TABLE "issue_key_aliases" ADD CONSTRAINT "issue_key_aliases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_key_aliases" ADD CONSTRAINT "issue_key_aliases_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_key_aliases_issue_id_index" ON "issue_key_aliases" USING btree ("issue_id");