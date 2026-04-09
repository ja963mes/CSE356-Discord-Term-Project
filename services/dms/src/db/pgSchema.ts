/**
 * Must stay aligned with `services/auth/src/db/schema.ts` (same Postgres tables).
 * Only the tables the DMS service needs are included here.
 */
import { pgTable, uuid, text, timestamp, primaryKey, index } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  internal_id: uuid("internal_id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
});

export const directConversations = pgTable("direct_conversations", {
  id: uuid("id").primaryKey(),
  type: text("type").notNull(),
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

export const readState = pgTable(
  "read_state",
  {
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.internal_id, { onDelete: "cascade" }),
    context_type: text("context_type").notNull(),
    context_id: uuid("context_id").notNull(),
    last_read_timeuuid: text("last_read_timeuuid").notNull(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.user_id, table.context_type, table.context_id] }),
    user_context_idx: index("read_state_user_context_idx").on(table.user_id, table.context_type),
  })
);
