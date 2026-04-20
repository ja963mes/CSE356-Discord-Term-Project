-- community_members lookup by community (GET /communities/:id/members was doing full table scan)
CREATE INDEX IF NOT EXISTS "community_members_community_id_idx" ON "community_members" USING btree ("community_id");--> statement-breakpoint
-- compound index for filtering public/private channels within a community
CREATE INDEX IF NOT EXISTS "channels_community_id_is_private_idx" ON "channels" USING btree ("community_id", "is_private");--> statement-breakpoint
-- compound index for covering user+community membership lookups
CREATE INDEX IF NOT EXISTS "community_members_user_id_community_id_idx" ON "community_members" USING btree ("user_id", "community_id");--> statement-breakpoint
-- compound index for channel membership lookups per user
CREATE INDEX IF NOT EXISTS "channel_members_user_id_channel_id_idx" ON "channel_members" USING btree ("user_id", "channel_id");
