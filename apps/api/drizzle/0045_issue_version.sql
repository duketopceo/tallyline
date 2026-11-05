ALTER TABLE "issues" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE FUNCTION "issues_bump_version"() RETURNS trigger AS $$
BEGIN
	NEW."version" := OLD."version" + 1;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "issues_bump_version" BEFORE UPDATE ON "issues" FOR EACH ROW EXECUTE FUNCTION "issues_bump_version"();
