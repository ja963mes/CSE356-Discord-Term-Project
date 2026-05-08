# Branch workflow

| Branch | Role |
|--------|------|
| **`main-dev`** | Shared integration; typical deploy / autograder target |
| **`nick`** | Default long-lived dev branch — open PRs **`nick` → `main-dev`** |

GitHub only shows a meaningful PR diff when your branch is **ahead of the base** (at least one commit). If `nick` and `main-dev` match, commit on `nick`, push, then open or update the PR.

### Before you open or update a PR

Merge latest integration into your branch and fix conflicts locally:

```bash
git fetch origin && git checkout nick && git merge origin/main-dev && git push origin nick
```

After a merge to `main-dev`, repeat so `nick` stays current.

### Alternative

Short-lived branches from `main-dev` (e.g. `feat/…`) with PRs into `main-dev` work the same way.
