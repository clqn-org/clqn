CREATE SEQUENCE "public"."agent_alias_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."task_alias_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "alias" text DEFAULT 'agent-' || nextval('agent_alias_seq') NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "alias" text DEFAULT 'task-' || nextval('task_alias_seq') NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_alias_unique" UNIQUE("alias");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_alias_unique" UNIQUE("alias");