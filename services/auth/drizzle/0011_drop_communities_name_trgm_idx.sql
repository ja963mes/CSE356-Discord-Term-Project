-- Directory name search uses Elasticsearch (search-service); Postgres trigram index is unused.
-- Extension pg_trgm may remain; only the GIN index from migration 0010 is removed.
DROP INDEX IF EXISTS "communities_name_trgm_idx";--> statement-breakpoint
