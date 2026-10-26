CREATE TABLE "glitchtip_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"token_last4" text NOT NULL,
	"glitchtip_host" text,
	"project_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_team_key" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"last_received_at" timestamp with time zone,
	CONSTRAINT "glitchtip_integrations_workspace_id_unique" UNIQUE("workspace_id"),
	CONSTRAINT "glitchtip_integrations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "glitchtip_integrations" ADD CONSTRAINT "glitchtip_integrations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;