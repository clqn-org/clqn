CREATE TABLE "cloud_chat_quota" (
	"id" smallint PRIMARY KEY NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"calls" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_worker_presence" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "cloud_lease_id" uuid;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "cloud_message_id" uuid;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "cloud_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "cloud_last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "cloud_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "cloud_attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_worker_presence" ADD CONSTRAINT "cloud_worker_presence_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;