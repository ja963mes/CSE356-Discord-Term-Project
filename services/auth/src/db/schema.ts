import { pgTable, uuid, text, jsonb, timestamp, unique, integer, primaryKey, boolean, index } from "drizzle-orm/pg-core";

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
  provider: text("provider").notNull(),   // "google", "github", "oidc"
  provider_uid: text("provider_uid").notNull(),
  created_at: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  unique_provider: unique().on(table.provider, table.provider_uid),
}));

/** A community (guild / server): named space with members and channels. */
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

/** Per-channel membership: required to read/post history (public channels still use join). */
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

/** DM / group conversation metadata. Message content lives in Cassandra. */
export const directConversations = pgTable("direct_conversations", {
  id: uuid("id").primaryKey(),
  type: text("type").notNull(), // "one_to_one" | "group"
  name: text("name"),
  created_by: uuid("created_by")
    .notNull()
    .references(() => users.internal_id, { onDelete: "restrict" }),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export const dmParticipants = pgTable(
  "dm_participants",
  {
    conversation_id: uuid("conversation_id")
      .notNull()
      .references(() => directConversations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.internal_id, { onDelete: "cascade" }),
    joined_at: timestamp("joined_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.conversation_id, table.user_id] }),
    user_idx: index("dm_participants_user_idx").on(table.user_id),
  })
);

