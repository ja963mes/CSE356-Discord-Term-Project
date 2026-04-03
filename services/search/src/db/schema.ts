/**
 * Must stay aligned with `services/auth/src/db/schema.ts`.
 * Read-only subset needed for search ACL queries.
 */

import { pgTable, uuid, text, timestamp, primaryKey, boolean, integer, index } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  internal_id: uuid("internal_id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
});

export const communities = pgTable("communities", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const communityMembers = pgTable(
  "community_members",
  {
    community_id: uuid("community_id").notNull(),
    user_id: uuid("user_id").notNull(),
    role: text("role").notNull().default("member"),
    joined_at: timestamp("joined_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.community_id, table.user_id] }),
  })
);

export const channels = pgTable("channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  community_id: uuid("community_id").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  position: integer("position").notNull().default(0),
  is_private: boolean("is_private").notNull().default(false),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const channelMembers = pgTable(
  "channel_members",
  {
    channel_id: uuid("channel_id").notNull(),
    user_id: uuid("user_id").notNull(),
    joined_at: timestamp("joined_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.channel_id, table.user_id] }),
  })
);

export const directConversations = pgTable("direct_conversations", {
  id: uuid("id").primaryKey(),
  type: text("type").notNull(),
  name: text("name"),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export const dmParticipants = pgTable(
  "dm_participants",
  {
    conversation_id: uuid("conversation_id").notNull(),
    user_id: uuid("user_id").notNull(),
    joined_at: timestamp("joined_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.conversation_id, table.user_id] }),
    user_idx: index("dm_participants_user_idx").on(table.user_id),
  })
);
