CREATE TABLE "github_logins" (
	"handle_hash" text PRIMARY KEY NOT NULL,
	"device_code" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"next_poll_at" timestamp with time zone NOT NULL,
	"interval" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "github_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_github_id_unique" UNIQUE("github_id");