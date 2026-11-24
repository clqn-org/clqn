CREATE TABLE "chat_members" (
	"clan_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"settings" jsonb NOT NULL,
	CONSTRAINT "chat_members_clan_id_user_id_pk" PRIMARY KEY("clan_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"clan_id" uuid NOT NULL,
	"sequence" bigserial NOT NULL,
	"author_id" uuid NOT NULL,
	"author" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"text" text NOT NULL,
	"status" text NOT NULL,
	"reply_to" uuid,
	"worker_id" uuid,
	"proposal" jsonb,
	"task_id" uuid,
	"tokens" bigint
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"clan_id" uuid PRIMARY KEY NOT NULL,
	"host_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_clan_id_chats_clan_id_fk" FOREIGN KEY ("clan_id") REFERENCES "public"."chats"("clan_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_clan_id_user_id_memberships_clan_id_user_id_fk" FOREIGN KEY ("clan_id","user_id") REFERENCES "public"."memberships"("clan_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_clan_id_chats_clan_id_fk" FOREIGN KEY ("clan_id") REFERENCES "public"."chats"("clan_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_worker_id_agents_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_clan_id_clans_id_fk" FOREIGN KEY ("clan_id") REFERENCES "public"."clans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_host_id_users_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_messages_history_idx" ON "chat_messages" USING btree ("clan_id","sequence");--> statement-breakpoint
CREATE INDEX "chat_messages_queue_idx" ON "chat_messages" USING btree ("clan_id","status","sequence");--> statement-breakpoint
CREATE INDEX "chat_messages_worker_idx" ON "chat_messages" USING btree ("clan_id","worker_id") WHERE "chat_messages"."worker_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_task_idx" ON "chat_messages" USING btree ("task_id") WHERE "chat_messages"."task_id" is not null;