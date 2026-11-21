CREATE INDEX "events_clan_sequence_idx" ON "events" USING btree ("clan_id","sequence");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");