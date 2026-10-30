CREATE TABLE "push_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"disabled_kinds" text[] DEFAULT '{}'::text[] NOT NULL,
	"quiet_start" integer,
	"quiet_end" integer,
	"tz" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "push_handle" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "push_env" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "push_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "push_preferences" ADD CONSTRAINT "push_preferences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_preferences" ADD CONSTRAINT "push_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_preferences_workspace_id_user_id_index" ON "push_preferences" USING btree ("workspace_id","user_id");