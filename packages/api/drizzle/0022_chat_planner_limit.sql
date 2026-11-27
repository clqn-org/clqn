ALTER TABLE "chats" ADD COLUMN "planner_limit" integer;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_planner_limit_positive" CHECK ("chats"."planner_limit" > 0);