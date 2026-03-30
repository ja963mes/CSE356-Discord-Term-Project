/**
 * Must stay aligned with `services/auth/src/db/schema.ts` (same Postgres tables).
 */
import { pgTable, uuid, text, jsonb, timestamp, unique, integer, primaryKey, boolean } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  internal_id: uuid("internal_id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  email: text("email"),
  password_hash: text("password_hash"),
  profile: jsonb("profile").notNull().default({}),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const identities = pgTable("identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  internal_id: uuid("internal_id")
    .notNull()
    .references(() => users.internal_id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  provider_uid: text("provider_uid").notNull(),
  created_at: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  unique_provider: unique().on(table.provider, table.provider_uid),
}));

export const communities = pgTable("communities", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  created_by: uuid("created_by")
    .notNull()
    .references(() => users.internal_id, { onDelete: "restrict" }),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const communityMembers = pgTable(
  "community_members",
  {
    community_id: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.internal_id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    joined_at: timestamp("joined_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.community_id, table.user_id] }),
  })
);

export const channels = pgTable("channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  community_id: uuid("community_id")
    .notNull()
    .references(() => communities.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  position: integer("position").notNull().default(0),
  is_private: boolean("is_private").notNull().default(false),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const channelMembers = pgTable(
  "channel_members",
  {
    channel_id: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.internal_id, { onDelete: "cascade" }),
    joined_at: timestamp("joined_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.channel_id, table.user_id] }),
  })
);
