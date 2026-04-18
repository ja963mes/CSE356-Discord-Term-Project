CREATE INDEX IF NOT EXISTS "channel_members_user_id_idx" ON "channel_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channels_community_id_idx" ON "channels" USING btree ("community_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "community_members_user_id_idx" ON "community_members" USING btree ("user_id");