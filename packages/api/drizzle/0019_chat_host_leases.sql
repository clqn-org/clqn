CREATE TABLE "chat_backups" (
	"clan_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "chat_backups_clan_id_user_id_pk" PRIMARY KEY("clan_id","user_id")
);
--> statement-breakpoint
DROP INDEX "agents_one_orchestrator_per_clan";--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "lease_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "lease_id" uuid;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_backups" ADD CONSTRAINT "chat_backups_clan_id_chats_clan_id_fk" FOREIGN KEY ("clan_id") REFERENCES "public"."chats"("clan_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_backups" ADD CONSTRAINT "chat_backups_clan_id_user_id_memberships_clan_id_user_id_fk" FOREIGN KEY ("clan_id","user_id") REFERENCES "public"."memberships"("clan_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_lease_agent_id_agents_id_fk" FOREIGN KEY ("lease_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_one_orchestrator_per_owner" ON "agents" USING btree ("clan_id","owner_id") WHERE "agents"."role" = 'orchestrator';--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_host_lease_fields" CHECK (("chats"."lease_agent_id" is null and "chats"."lease_id" is null and "chats"."lease_expires_at" is null)
        or ("chats"."lease_agent_id" is not null and "chats"."lease_id" is not null));--> statement-breakpoint
UPDATE "chats" SET "host_id" = "memberships"."user_id" FROM "memberships"
WHERE "memberships"."clan_id" = "chats"."clan_id" AND "memberships"."role" = 'leader'
AND "chats"."host_id" <> "memberships"."user_id";
