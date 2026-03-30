export const buildSchemaStatementsTemp = (keyspace: string): string[] => [
    `CREATE KEYSPACE IF NOT EXISTS ${keyspace} WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};`,
];

export const buildSchemaStatements = (keyspace: string): string[] => [
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
