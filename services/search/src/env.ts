import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
if (process.env.ENV_FILE) {
  dotenv.config({ path: process.env.ENV_FILE, override: true });
}

const envSchema = z.object({
  SEARCH_PORT: z.string().default("3004"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string(),
  ELASTICSEARCH_URL: z.string().default("http://localhost:9200"),
  ES_INDEX_NAME: z.string().default("messages"),
  /** Elasticsearch index for public community directory search (`/directory/communities`). */
  ES_COMMUNITIES_INDEX_NAME: z.string().default("communities_directory"),
});

export const env = envSchema.parse(process.env);
