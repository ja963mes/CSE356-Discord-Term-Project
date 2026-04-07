ALTER TABLE "db_participants" RENAME TO "dm_participants";--> statement-breakpoint
ALTER TABLE "dm_participants" DROP CONSTRAINT "db_participants_conversation_id_direct_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE "dm_participants" DROP CONSTRAINT "db_participants_user_id_users_internal_id_fk";
--> statement-breakpoint
ALTER TABLE "dm_participants" DROP CONSTRAINT "db_participants_conversation_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "direct_conversations" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "direct_messages" ALTER COLUMN "author_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "direct_messages" ALTER COLUMN "updated_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "direct_messages" ALTER COLUMN "updated_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "dm_participants" ADD CONSTRAINT "dm_participants_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id");--> statement-breakpoint
ALTER TABLE "dm_participants" ADD CONSTRAINT "dm_participants_conversation_id_direct_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."direct_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_participants" ADD CONSTRAINT "dm_participants_user_id_users_internal_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("internal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_participants" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "direct_messages" DROP COLUMN "type";