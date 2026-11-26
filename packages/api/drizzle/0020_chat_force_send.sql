DROP INDEX "chat_messages_queue_idx";--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "force" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "pick_id" uuid;--> statement-breakpoint
CREATE INDEX "chat_messages_queue_idx" ON "chat_messages" USING btree ("clan_id","status","force" DESC NULLS LAST,"sequence");