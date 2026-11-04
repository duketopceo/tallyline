CREATE TABLE "reporter_handles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"credential_id" uuid,
	"reporter_email" text,
	"reporter_name" text,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_viewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reporter_handles_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "reporter_reply_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"handle_id" uuid,
	"comment_id" uuid NOT NULL,
	"to_email" text NOT NULL,
	"sent_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reporter_reply_deliveries_comment_id_unique" UNIQUE("comment_id")
);
--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "visibility" text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "reporter_handles" ADD CONSTRAINT "reporter_handles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reporter_handles" ADD CONSTRAINT "reporter_handles_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reporter_handles" ADD CONSTRAINT "reporter_handles_credential_id_intake_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."intake_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reporter_reply_deliveries" ADD CONSTRAINT "reporter_reply_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reporter_reply_deliveries" ADD CONSTRAINT "reporter_reply_deliveries_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reporter_reply_deliveries" ADD CONSTRAINT "reporter_reply_deliveries_handle_id_reporter_handles_id_fk" FOREIGN KEY ("handle_id") REFERENCES "public"."reporter_handles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reporter_reply_deliveries" ADD CONSTRAINT "reporter_reply_deliveries_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reporter_handles_issue_id_index" ON "reporter_handles" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "reporter_handles_workspace_id_index" ON "reporter_handles" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "reporter_reply_deliveries_issue_id_index" ON "reporter_reply_deliveries" USING btree ("issue_id");