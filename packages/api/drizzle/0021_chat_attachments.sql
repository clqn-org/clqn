CREATE TABLE "chat_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clan_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"size" integer NOT NULL,
	"data" "bytea" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "attachments" jsonb;--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_clan_id_chats_clan_id_fk" FOREIGN KEY ("clan_id") REFERENCES "public"."chats"("clan_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_attachments_message_idx" ON "chat_attachments" USING btree ("message_id");