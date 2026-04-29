# Rollback Guide

## How to rollback

1. Find the commit SHA or tag you want to roll back to:
   ```bash
   git log --oneline main-dev
   ```

2. Go to **GitHub → Actions → "CI and deploy staging" → Run workflow**

3. Fill in the inputs:
   | Input | Value |
   |-------|-------|
   | `ref` | Commit SHA, tag, or branch (e.g. `7d6803b`) |
   | `limit` | Services to rollback (e.g. `read_state,dms`). Leave blank for all. |

4. Click **Run workflow**.

## Rollback a single service

Use the `limit` input to target only the broken service:

```
ref:   7d6803b
limit: read_state
```

This deploys commit `7d6803b` to the read-state VM only. All other VMs stay on current HEAD.

## Rollback all services

Leave `limit` blank — full deploy of the specified `ref` across all VMs.

## Finding the right commit

```bash
# last 20 commits
git log --oneline -20 main-dev

# commits that touched a specific service
git log --oneline -- services/read-state/
```

## Notes

- Tags and commit SHAs deploy in detached HEAD mode — no `git pull` runs, the repo is pinned to that exact ref.
- After rollback, push a fix to `main-dev` and let the normal CD pipeline redeploy.
- DB migrations run on every backend deploy — rolling back past a schema migration requires manual intervention (restore DB snapshot or write a down-migration).
