-- DEPRECATED: directory search uses Elasticsearch (search-service); migration 0011 drops the GIN index.
-- Was: speed up GET /search-communities (ILIKE '%q%') via trigram GIN index.
-- Requires pg_trgm (bundled as "contrib" on most Postgres images; CREATE EXTENSION needs DB superuser or equivalent).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "communities_name_trgm_idx" ON "communities" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
