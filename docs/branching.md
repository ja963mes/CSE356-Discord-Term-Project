# Branch workflow

- **Integration:** `main-dev`
- **Day-to-day work:** `nick` — open PRs **from `nick` → `main-dev`**.

GitHub only builds a PR when `nick` is **ahead of** `main-dev` (at least one commit). If both branches point at the same commit, add your changes on `nick` and push, then open the PR.

After a PR is merged into `main-dev`, sync `nick`:

```bash
git fetch origin && git checkout nick && git merge origin/main-dev && git push origin nick
```

Alternatively, use a short-lived branch from `main-dev` (e.g. `feat/…`) and PR that into `main-dev` instead.
