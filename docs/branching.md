# Branch workflow

- **Integration:** `main-dev` — this is the branch shared with teammates and the usual deploy/autograder target.
- **Day-to-day work:** `nick` — **open PRs from `nick` → `main-dev`** (this is the default integration path).

GitHub only builds a PR when `nick` is **ahead of** `main-dev` (at least one commit). If both branches point at the same commit, add your changes on `nick` and push, then open the PR.

**Before you open or update a PR**, bring `main-dev` into `nick` so your branch includes the latest integration history and you resolve conflicts locally:

```bash
git fetch origin && git checkout nick && git merge origin/main-dev && git push origin nick
```

After a PR is merged into `main-dev`, run the same merge (or repeat it) so `nick` stays current.

Alternatively, use a short-lived branch from `main-dev` (e.g. `feat/…`) and PR that into `main-dev` instead.
