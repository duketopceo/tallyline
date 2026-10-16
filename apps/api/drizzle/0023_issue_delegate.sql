ALTER TABLE "issues" ADD COLUMN "delegate_type" "actor_type";--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "delegate_id" uuid;--> statement-breakpoint
CREATE INDEX "issues_workspace_id_delegate_id_index" ON "issues" USING btree ("workspace_id","delegate_id");