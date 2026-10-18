-- Plan import hardening. The unique constraint fails if a project already has two
-- milestones with the same title; check before deploy (prod had none at audit).
ALTER TABLE "issue_external_refs" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_project_id_title_unique" UNIQUE("project_id","title");