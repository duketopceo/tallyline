CREATE TABLE "device_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"client_name" text NOT NULL,
	"request_ip" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"interval_s" integer DEFAULT 5 NOT NULL,
	"last_polled_at" timestamp with time zone,
	"user_id" uuid,
	"approved_workspace_id" uuid,
	"scopes" jsonb DEFAULT '["read","write"]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_authorizations_device_code_hash_unique" UNIQUE("device_code_hash")
);
--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD CONSTRAINT "device_authorizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD CONSTRAINT "device_authorizations_approved_workspace_id_workspaces_id_fk" FOREIGN KEY ("approved_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_authorizations_user_code_index" ON "device_authorizations" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "device_authorizations_expires_at_index" ON "device_authorizations" USING btree ("expires_at");