# Nginx Configs

All nginx example configs are centralized here.

Current split pattern:

- Frontend nginx serves SPA and proxies:
  - `/auth` -> auth-service directly on auth VM private IP (`:3001`)
  - non-auth API + `/ws` -> backend nginx
  - `/search` -> dedicated search ingress (optional but recommended)

## Supported

- `production-frontend.conf.example`
- `production-backend.conf.example`
- `production-search.conf.example`

## Deprecated

Legacy templates are retained under `deprecated/` for reference only:

- `deprecated/linode-staging.conf.example`
- `deprecated/linode-production-combined.conf.example`
- `deprecated/linode-services-only.conf.example`

