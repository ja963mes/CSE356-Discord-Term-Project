import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";

// Copy the minimal Postgres schema needed for directory search.
// Must stay aligned with `services/auth/src/db/schema.ts` / `services/communities/src/db/schema.ts`.
export const users = pgTable("users", {
  internal_id: uuid("internal_id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  email: text("email"),
  password_hash: text("password_hash"),
  profile: jsonb("profile").notNull().default({}),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const communities = pgTable("communities", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  created_by: uuid("created_by")
    .notNull()
    .references(() => users.internal_id, { onDelete: "restrict" }),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

