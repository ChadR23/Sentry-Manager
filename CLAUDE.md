# Working on Sentry Six Manager

## Pushing to main (owner's rule)

- Finished, tested work goes to `release/next-update` only. Nothing goes to
  `main` until the owner says to push it to `main`. "Push it when it's
  ready" means push to `release/next-update`, not to `main`.
- With every change that alters how the app looks or behaves, send desktop
  and phone screenshots of every page it touches.
- Every push to `main` builds and publishes the Docker image the owner runs
  (`latest`), so `main` is what goes live.
- Documentation-only changes (`README.md`, `docs/`) may go to `main` directly.

## Branches (owner's rule: no new branches per feature)

Only these branches exist on GitHub:

- `main`: what goes live.
- `release/next-update`: staged work that is finished, tested and ready for
  `main`, waiting for the owner to say push it. No image is built from it.
- `wip`: work that is not finished yet, built while `release/next-update`
  waits for the owner.

Never create another branch for a feature. Helper agents work in git
worktrees on a detached HEAD (`git worktree add --detach`), and their
commits are merged into one of the two branches above by commit id.

After `release/next-update` goes to `main`, reset it to `main` so it is empty
for the next update. Then move the finished work from `wip` into it, and
reset `wip` to `main` as well.

This session cannot delete branches on GitHub (403). Ask the owner to delete
any stray branch.

## Standing rules

- Everything stays inside the one Docker container: no external services,
  no extra containers (no Glances, Netdata, socket proxies, cloud APIs).
- Passwords only over HTTPS; never plain HTTP with passwords.
- No co-author trailers in commits, no model names in commits or code.
- No pull requests unless the owner asks.
- Run `npm test` before every push.
