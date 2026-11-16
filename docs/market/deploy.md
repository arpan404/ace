# Deploying the market Worker

`apps/market` is ace's marketplace at `market.acehq.dev` (ADR 0168, ADR 0173): the catalog API,
Discover, publishers' profiles and publishing, the scan pipeline, the signer's routes, and the
public web page. Deploying it is the owner's step; nothing
in the repository deploys it or talks to a Cloudflare account.

Run each command from `apps/market`.

1. **Create the database and the bucket.**

   ```sh
   bunx wrangler d1 create ace-market
   bunx wrangler r2 bucket create ace-market-objects
   ```

   Put the database id `d1 create` prints into `wrangler.jsonc`, under `env.production`
   (`d1_databases[0].database_id`).

2. **Apply the migrations.**

   ```sh
   bunx wrangler d1 migrations apply MARKET --remote --env production
   ```

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
   session's sign-in time and a verified email (ADR 0173 §2), and an older backend's grants are
   refused.

   The rate-limit bindings (`READS`, `PUBLISHES`, `DOWNLOADS`, `REPORTS`) need nothing beyond
   `wrangler.jsonc`; they count in memory and store no address.

4. **Deploy.**

   ```sh
   bunx wrangler deploy --env production
   ```

   The custom domain `market.acehq.dev` is attached by the route in `wrangler.jsonc`. Request
   logs stay off (`observability.enabled: false`).

5. **Seed it.** Mint a market grant for ace's own account: `POST https://cloud.acehq.dev/v1/grants`
   with the account's session as the bearer and
   `{"purpose":"market-publish","kind":"device","subject":"<a device id>"}`. The grant lasts
   five minutes, so run the seed right away:

   ```sh
   ACE_MARKET_GRANT=<token> ACE_MARKET_SIGNER_TOKEN=<signer token> \
     node scripts/seed.ts https://market.acehq.dev
   ```

   Before the seed, put ace's own account on the official list, so it publishes as `ace`
   (ADR 0173 §14):

   ```sh
   ACE_MARKET_SIGNER_TOKEN=<signer token> ace market official add <account id> --key <key file>
   ```

   The signer token, when given, also uploads `seed/categories.json`. Every version published as
   `ace` is held for a maintainer: run `ace market review`, approve ace's entries, run
   `ace market sign`, then mark them reviewed and pick the featured list and collections.

6. **The cron** runs every quarter hour (`triggers.crons`): download totals, scan steps that
   didn't fit a request, trending in batches, verification re-checks and pruning, each step
   bounded. Nothing else needs scheduling.

After changing `spade/config/templates.json`, rebuild the seed's recipes with
`node scripts/build-seed.ts` and commit the result.
