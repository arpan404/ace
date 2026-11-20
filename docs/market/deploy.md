# Deploying the market Worker

`apps/market` is ace's marketplace at `market.acehq.dev` (ADR 0168, ADR 0174): the catalog API,
Discover, publishers' profiles and publishing, the scan pipeline, and the signer's routes. The
Worker serves the API only: the public web page was removed at the owner's request, `GET /` answers a
small JSON body and any other path outside `/v1` is a JSON 404. Deploying it is the owner's step;
nothing in the repository deploys it or talks to a Cloudflare account.

Run each command from `apps/market`.

1. **Create the databases and the bucket.** The market keeps one D1 database per entry type
   and one per shared domain (ADR 0174 §16):

   | Database                | Binding             | Migrations              |
   | ----------------------- | ------------------- | ----------------------- |
   | `ace-market-suits`      | `MARKET_SUITS`      | `migrations/catalogue`  |
   | `ace-market-skills`     | `MARKET_SKILLS`     | `migrations/catalogue`  |
   | `ace-market-plugins`    | `MARKET_PLUGINS`    | `migrations/catalogue`  |
   | `ace-market-bots`       | `MARKET_BOTS`       | `migrations/catalogue`  |
   | `ace-market-publishers` | `MARKET_PUBLISHERS` | `migrations/publishers` |
   | `ace-market-counts`     | `MARKET_COUNTS`     | `migrations/counts`     |
   | `ace-market-moderation` | `MARKET_MODERATION` | `migrations/moderation` |
   | `ace-market-lists`      | `MARKET_LISTS`      | `migrations/lists`      |

   ```sh
   for name in suits skills plugins bots publishers counts moderation lists; do
     bunx wrangler d1 create "ace-market-$name"
   done
   bunx wrangler r2 bucket create ace-market-objects
   ```

   The production ids are in `wrangler.jsonc` under `env.production.d1_databases`; a database
   made again needs its new id there. The single `ace-market` database the Worker used before the
   split held no data and has no binding any more; delete it with
   `bunx wrangler d1 delete ace-market`.

2. **Apply the migrations**, each database from its own folder:

   ```sh
   for binding in MARKET_SUITS MARKET_SKILLS MARKET_PLUGINS MARKET_BOTS \
       MARKET_PUBLISHERS MARKET_COUNTS MARKET_MODERATION MARKET_LISTS; do
     bunx wrangler d1 migrations apply "$binding" --remote --env production
   done
   ```

   Run the same loop after any change under `migrations/`. A later entry type (`ace-plugin`) is
   a new database created from `migrations/catalogue`, a binding in `wrangler.jsonc` and an entry
   in `catalogueBindings` (`src/store/databases.ts`).

3. **Set the secrets and keys.**

   - `MARKET_SIGNER_TOKEN`: a long random token, kept with the signer.

     ```sh
     openssl rand -base64 48 | bunx wrangler secret put MARKET_SIGNER_TOKEN --env production
     ```

   - `MARKET_PUBLIC_KEYS`: the market's public keys as JSON, `{"keys":[{"id":"…","publicKey":"…"}]}`,
     from `ace market keygen`. The same keys go in `shippedMarketKeys` in
     `packages/marketplace/src/keys.ts`, so devices trust what the Worker lists. The private key
     never goes to Cloudflare.

     ```sh
     bunx wrangler secret put MARKET_PUBLIC_KEYS --env production
     ```

   Publishing grants are checked against ace cloud's `/v1/keys` (`ACE_ACCOUNT_KEYS_URL`, set in
   `wrangler.jsonc`) and must name `cloud.acehq.dev` as their issuer (`ACE_GRANT_ISSUER` changes
   it, for a staging backend). Leave `ACE_GRANT_KEYS` unset in production. ace cloud must be
   deployed with its migration `0003_session_signed_in.sql` first: market grants carry the
   session's sign-in time and a verified email (ADR 0174 §2), and an older backend's grants are
   refused.

   The rate-limit bindings (`READS`, `PUBLISHES`, `DOWNLOADS`, `REPORTS`) need nothing beyond
   `wrangler.jsonc`; they count in memory and store no address.

4. **Deploy.**

   ```sh
   bunx wrangler deploy --env production
   ```

   The custom domain `market.acehq.dev` is attached by the route in `wrangler.jsonc`. Request
   logs stay off (`observability.enabled: false`). After this first deploy, release tags deploy
   the market with `bun run deploy:workers`, staging (`staging.market.acehq.dev`) first, with a
   smoke and an automatic rollback ([docs/release/workers.md](../release/workers.md)).
   `bun run smoke https://market.acehq.dev` checks it by hand without writing anything.

5. **Seed it.** Mint a market grant for ace's own account: `POST https://cloud.acehq.dev/v1/grants`
   with the account's session as the bearer and
   `{"purpose":"market-publish","kind":"device","subject":"<a device id>"}`. The grant lasts
   five minutes, so run the seed right away:

   ```sh
   ACE_MARKET_GRANT=<token> ACE_MARKET_SIGNER_TOKEN=<signer token> \
     node scripts/seed.ts https://market.acehq.dev
   ```

   Before the seed, put ace's own account on the official list, so it publishes as `ace`
   (ADR 0174 §14):

   ```sh
   ACE_MARKET_SIGNER_TOKEN=<signer token> ace market official add <account id> --key <key file>
   ```

   The signer token, when given, also uploads `seed/categories.json`. Every version published as
   `ace` is held for a maintainer: run `ace market review`, approve ace's entries, run
   `ace market sign`, then mark them reviewed and pick the featured list and collections.

6. **The cron** runs every quarter hour (`triggers.crons`): download totals, scan steps that
   didn't fit a request, trending in batches, verification re-checks and pruning, each step
   bounded. It also finishes any cross-database step a request was cut off in (publisher copies,
   draft publishes, the withdrawn list, the quota ledger). Nothing else needs scheduling.

7. **Watch the sizes.** Once a day the cron records every database's size and each table's
   rows in the counts database. To read the latest:

   ```sh
   bunx wrangler d1 execute ace-market-counts --remote --env production --command \
     "SELECT database, bytes FROM database_sizes WHERE day = (SELECT MAX(day) FROM database_sizes)"
   ```

   Split a database further before it nears 5 GB (D1 stops at 10 GB); ADR 0174 §16 names the
   next cut for each.

The seed's bots are Spade's built-in templates: each `seed/spade-bot/<id>/` holds only its
`market.json`, and its package files are read from `spade/templates/<id>/`.
