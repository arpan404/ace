# Releasing ace cloud and the Store

ace runs two Cloudflare Workers:

| Worker    | Script       | Production                            |
| --------- | ------------ | ------------------------------------- |
| ace cloud | `ace-relay`  | `cloud.acehq.dev`, `relay.acehq.dev`  |
| The Store | `ace-market` | `store.acehq.dev`, `market.acehq.dev` |

Both are configured in their `wrangler.jsonc`: `env.production`, and a top level used only for
local development and tests. Production's script keeps the name `ace-relay`: its Durable Objects
belong to that name ([ADR 0141](../adr/0141-ace-cloud.md)).

## The deploy command

```sh
bun run deploy:workers production [--version <tag>]
```

This deploys ace cloud, then the market: the market checks publishing grants against ace cloud's
keys, so ace cloud goes first. Each Worker also has its own entry point:
`bun run --cwd apps/cloud deploy:release production …` and
`bun run --cwd apps/market deploy:release production …`.
The code is in `tools/workers-release`.

It needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment, and a checkout
with no uncommitted changes to tracked files: each version's message names the commit it was
built from. Without `--version`, the release is named `git-<first 12 characters of the commit>`.

For each Worker, in order:

1. **Lint the migrations** (below). A problem stops the release before anything changes.
2. **Check the environment's resources.** A D1 `database_id` that is still a placeholder (or a
   development id) stops the release.
3. **Skip if it is already out.** When this release's version already serves 100% of traffic,
   with the same tag and the same commit, nothing is deployed: the command only smokes it, and
   exits 0 if it passes (3 if it doesn't). Re-running a release is safe.
4. **Apply D1 migrations** to every database the environment binds
   (`wrangler d1 migrations apply <binding> --remote`).
5. **Deploy** the new version to 100% of traffic (`wrangler deploy --tag <tag> --message
"ace <tag> (<commit>)"`).
6. **Smoke every custom domain** of the environment, 20 seconds after the deploy, up to three
   times 15 seconds apart while the new version propagates.
7. **Roll back** if the smoke still fails: `wrangler rollback <previous version>`, then the same
   smoke against the previous version.

If traffic is already split between two versions (a gradual deployment someone started by
hand), the command refuses: there would be no single version to roll back to. Finish or roll
back that deployment first.

### Exit codes

The release workflow reads these:

| Code | Meaning                                                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | The release is live and passes its smoke, or it already was.                                                                                                                        |
| 1    | Refused, or failed before the new version went live. The previous version still serves. Migrations may have been applied; they only expand, so that is safe.                        |
| 2    | The new version went live, failed its smoke, and was rolled back. The previous version serves and passes its smoke.                                                                 |
| 3    | Needs a human now: the new version failed and the rollback was refused or failed, the previous version also fails its smoke, or a first deploy failed with nothing to roll back to. |
| 64   | Bad arguments.                                                                                                                                                                      |

With `all` Workers, the command stops at the first Worker that doesn't exit 0 and returns that
Worker's code, so the market never deploys after a failed ace cloud. The last line of each
Worker's output is `RESULT <code> <summary>`.

### The release workflow

On a release tag:

```sh
bun run deploy:workers production --version "$TAG"
```

Run one deploy at a time (a concurrency group that is never cancelled mid-run) and give it
`CI=1`. The command sets `CI=1` for wrangler itself, so wrangler never prompts.

## Smoke checks

- **ace cloud** (`apps/cloud/scripts/smoke.ts`): the Worker answers, grant keys are published, a
  sign-in starts and is cancelled, relay upgrades without a grant are refused, and Spade's broker
  wants a credential. It runs against each hostname. It is not strictly read-only: starting and
  cancelling the sign-in writes and deletes a row in that environment's `ace-accounts` D1
  database, and starting a sign-in also sweeps expired sign-ins and sessions there, as any real
  sign-in does.
- **The Store** (`apps/market/scripts/smoke.ts`): the Worker answers, unknown paths are JSON
  404s, the index parses as devices read it and revalidates to a 304, categories and featured
  answer, the withdrawn list is signed if there is one, publishing without a grant is refused,
  and one listed entry's install path works: its entry page, its signed version manifest (which
  must verify) and a `HEAD` of its archive. `HEAD` counts no download, so the smoke writes
  nothing. Against `store.acehq.dev` (and legacy `market.acehq.dev`), the manifest is verified
  with the keys this build ships, and an empty catalog fails. Anywhere else, set
  `ACE_MARKET_KEYS` to that Store's public keys (the `MARKET_PUBLIC_KEYS` JSON) to verify
  signatures; an empty catalog only skips the install path.

Each request and WebSocket handshake in the cloud smoke has its own deadline
(`ACE_SMOKE_TIMEOUT_MS`, 15 seconds by default), and the deploy kills any smoke still running
after 3 minutes. A hung smoke counts as a failed one, so the release rolls back.

Run either one by hand: `bun run --cwd apps/market smoke https://store.acehq.dev`.

## Migrations: expand, then contract

A release applies its D1 migrations before its Worker goes live, so the old Worker runs against
the new schema for a while. After a rollback, it runs against that schema indefinitely. Apps
released months ago keep calling both Workers. So **a migration only adds**:

- New tables, new indexes, new nullable columns, or new `NOT NULL` columns with a `DEFAULT`.
- To rename or remove something, **expand** first: add the new column or table, ship code that
  writes both and reads the new one. Then, in a **later** release, once no deployed version or
  supported app reads the old one, **contract**: drop it.

`bun run check:migrations` (part of `bun run check`, and of every deploy) refuses statements
that break an older version:

| Rule                       | Refuses                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `drop-table`               | `DROP TABLE`                                                       |
| `drop-view`                | `DROP VIEW`                                                        |
| `drop-column`              | `ALTER TABLE … DROP [COLUMN]`                                      |
| `rename`                   | `ALTER TABLE … RENAME [TO / COLUMN]`                               |
| `not-null-without-default` | `ALTER TABLE … ADD [COLUMN] … NOT NULL` without `DEFAULT`          |
| `delete-without-where`     | `DELETE FROM …` without a top-level `WHERE` (also after `WITH …`)  |
| `update-without-where`     | `UPDATE … SET …` without a top-level `WHERE` (also after `WITH …`) |

A contract migration opts out explicitly, in its own file, one line per rule, with a reason of at
least 20 characters:

```sql
-- migration-lint allow drop-column: sessions.legacy_token unread since v1.4 (2026-08); apps before v1.4 are unsupported
ALTER TABLE sessions DROP COLUMN legacy_token;
```

Only a real `--` line comment counts as a marker: the same text inside a string or a `/* */`
comment is ignored. A `DELETE` or `UPDATE` inside a `CREATE TRIGGER` body is not checked, since
it runs per row later. An opt-out that allows nothing in its file is itself an error, so stale markers don't pile up.
D1 migrations are never rolled back by a Worker rollback. To undo a contract, use D1 Time Travel
(`bunx wrangler d1 time-travel restore <database> --timestamp <before> --env production`), which
also loses every write since.

## Durable Objects

ace cloud's `RelayObject` and `SignInObject` live under the script name. Two rules follow from how
Cloudflare versions them:

- **Ship a class change alone.** Adding, renaming or deleting a Durable Object class (a new entry
  in `migrations`) can't be rolled back: Cloudflare refuses a rollback to any version before the
  change. Put the class change in a release with no other changes. If its production smoke fails,
  the command exits 3.
- **Stay compatible both ways.** On a deploy, each active object keeps its old code until it
  hibernates, for at most 300 seconds (the default deferred code update), so a new Worker can
  talk to an old object and the reverse. The relay's and sign-in objects' messages and storage
  must work with both versions.

## Rolling back by hand

From the Worker's directory (`apps/cloud` or `apps/market`):

```sh
bunx wrangler deployments list --env production      # the recent deployments and their versions
bunx wrangler versions list --env production         # tags and messages name each release
bunx wrangler rollback <version-id> --env production --message "Back to v1.3.2: <why>"
bun run smoke https://cloud.acehq.dev                  # or the market's host
```

`wrangler rollback` without a version id returns to the version deployed before the current one.
A rollback changes code only: secrets, D1 data and R2 objects stay as they are. The next release
tag deploys forward again. Re-running the same tag on the same commit redeploys it, because what
serves is no longer that release.

## The Cloudflare API token

`CLOUDFLARE_API_TOKEN` (a repository secret) is a custom token limited to **ace's account**
(`CLOUDFLARE_ACCOUNT_ID` `7d4f0020b4776eb86cf81f5a5e47cae0`) with:

- Account › Workers Scripts › Edit: versions, deployments, rollbacks, secrets untouched.
- Account › D1 › Edit: migrations.
- Account › Workers R2 Storage › Edit: the market's bucket binding.
- Account › Cloudflare Pages › Edit: the web app's deploy to the `ace-web` project ([web.md](web.md)).
- Zone › Workers Routes › Edit, on the `acehq.dev` zone only: wrangler re-attaches each
  Worker's custom domains on every deploy, and custom domains are a zone setting.

Nothing else: no DNS, no other zone, no user permissions. Set it with
`gh secret set CLOUDFLARE_API_TOKEN`.
