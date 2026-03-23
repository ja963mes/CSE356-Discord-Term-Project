import { pgTable, uuid, text, jsonb, timestamp, unique } from "drizzle-orm/pg-core";

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