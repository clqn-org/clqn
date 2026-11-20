ALTER TABLE "agents" ADD COLUMN "alias" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "alias" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_clan_alias_idx" ON "agents" USING btree ("clan_id","alias");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_clan_alias_idx" ON "tasks" USING btree ("clan_id","alias");