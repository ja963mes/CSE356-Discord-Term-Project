export const buildSchemaStatementsTemp = (keyspace: string): string[] => [
    `CREATE KEYSPACE IF NOT EXISTS ${keyspace} WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};`,
];

export const buildSchemaStatements = (keyspace: string): string[] => [

  `CREATE TABLE IF NOT EXISTS ${keyspace}.conversations (
    conversation_id uuid PRIMARY KEY,
    conversation_type text,
    name text,
    created_by uuid,
    created_at timestamp,
    updated_at timestamp
  );`,
  `CREATE TABLE IF NOT EXISTS ${keyspace}.participants_by_conversation (
    conversation_id uuid,
    user_id uuid,
    joined_at timestamp,
    PRIMARY KEY ((conversation_id), user_id)
  );`,
  `CREATE TABLE IF NOT EXISTS ${keyspace}.conversations_by_user (
    user_id uuid,
    conversation_id uuid,
    conversation_type text,
    name text,
    created_at timestamp,
    updated_at timestamp,
    PRIMARY KEY ((user_id), conversation_id)
  );`,
  `CREATE TABLE IF NOT EXISTS ${keyspace}.messages_by_conversation (
    conversation_id uuid,
    created_at timeuuid,
    message_id uuid,
    author_id uuid,
    content text,
    attachments text,
    updated_at timestamp,
    is_deleted boolean,
    PRIMARY KEY ((conversation_id), created_at, message_id)
  ) WITH CLUSTERING ORDER BY (created_at DESC, message_id ASC);`,
];