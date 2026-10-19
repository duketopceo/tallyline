ALTER TABLE "issues" ADD COLUMN "milestone_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_milestone_id_project_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."project_milestones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issues_milestone_id_index" ON "issues" USING btree ("milestone_id");--> statement-breakpoint
INSERT INTO "labels" ("workspace_id", "name", "color")
SELECT w."id", d."name", d."color"
FROM "workspaces" w
CROSS JOIN (VALUES ('hitl', '#f59e0b'), ('launch-blocker', '#ef4444')) AS d("name", "color")
WHERE NOT EXISTS (
  SELECT 1 FROM "labels" l WHERE l."workspace_id" = w."id" AND l."name" = d."name"
);
