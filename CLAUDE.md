# Working on Sentry Six Manager

## Pushing to main (owner's rule)

- Nothing that changes how the app looks or behaves goes to `main` until the
  owner has checked it. Build and test on `release/next-update`, send
  desktop and phone screenshots of every page it touches, and push to `main`
  only after the owner says OK.

## Branches (owner's rule: no new branches per feature)

Only these branches exist on GitHub:

- `main`: what goes live.
- `release/next-update`: work in progress for the next update. It is pushed
  here so people can test it before it goes to `main`.
- `wip`: the update after that, built while `release/next-update` waits for
  the owner's OK.
- `backup/pre-flight-deck`: kept by the owner.

Never create another branch for a feature. Helper agents work in git
worktrees on a detached HEAD (`git worktree add --detach`), and their
commits are merged into one of the two branches above by commit id.

After `release/next-update` goes to `main`, reset it to `main` so it is empty
for the next update. Then move the work from `wip` into it, and reset `wip`
to `main` as well.

This session cannot delete branches on GitHub (403). Ask the owner to delete
any stray branch.
- Every push to `main` builds and publishes the Docker image the owner runs
  (`latest`), so `main` is what goes live.
- Documentation-only changes (`README.md`, `docs/`) may go to `main` directly.

## Standing rules

- Everything stays inside the one Docker container: no external services,
  no extra containers (no Glances, Netdata, socket proxies, cloud APIs).
- Passwords only over HTTPS; never plain HTTP with passwords.
- No co-author trailers in commits, no model names in commits or code.
- No pull requests unless the owner asks.
- Run `npm test` before every push.
