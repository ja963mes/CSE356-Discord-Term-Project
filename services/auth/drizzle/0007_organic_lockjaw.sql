CREATE TABLE "channel_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_author_id_users_internal_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("internal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_messages_channel_created_idx" ON "channel_messages" USING btree ("channel_id","created_at");