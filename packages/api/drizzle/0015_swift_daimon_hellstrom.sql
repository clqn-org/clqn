CREATE TABLE "chat_token_hours" (
	"clan_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"tokens" bigint NOT NULL,
	CONSTRAINT "chat_token_hours_clan_id_hour_pk" PRIMARY KEY("clan_id","hour")
);
--> statement-breakpoint
ALTER TABLE "chat_token_hours" ADD CONSTRAINT "chat_token_hours_clan_id_chats_clan_id_fk" FOREIGN KEY ("clan_id") REFERENCES "public"."chats"("clan_id") ON DELETE cascade ON UPDATE no action;