ALTER TABLE "chat_messages" ADD COLUMN "work_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "work_title" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "work_position" integer;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "work_order" bigint;--> statement-breakpoint
CREATE INDEX "chat_messages_work_idx" ON "chat_messages" USING btree ("clan_id","work_id","sequence");--> statement-breakpoint
CREATE INDEX "chat_messages_work_order_idx" ON "chat_messages" USING btree ("clan_id","work_id","work_order") WHERE "chat_messages"."work_order" is not null;
