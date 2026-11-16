# Deploying the market Worker

`apps/marketplace` is ace's marketplace at `market.acehq.dev` (ADR 0168): the catalog API, the
publishing and signer routes, and the public web page. Deploying it is the owner's step; nothing
in the repository deploys it or talks to a Cloudflare account.

Run each command from `apps/marketplace`.

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
   `wrangler.jsonc`). Leave `ACE_GRANT_KEYS` unset in production.

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

   The first publish takes the publisher name `ace` (`ACE_MARKET_PUBLISHER` to change it). The
   signer token, when given, also uploads `seed/categories.json`. Every seeded version then
   waits for the signer: run it, review ace's entries, mark them "By ace", and pick the
   featured list.

After changing `spade/config/templates.json`, rebuild the seed's recipes with
`node scripts/build-seed.ts` and commit the result.
