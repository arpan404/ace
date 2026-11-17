import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeArchive } from "@ace/marketplace";
import { readSeed, seedRoot } from "../src/seed/folders.ts";

/*
 * Publishes the seed to a market as `ace` (ADR 0173 §14): `node scripts/seed.ts
 * https://market.acehq.dev`, with a market publishing grant in ACE_MARKET_GRANT (it lasts five
 * minutes) for an ace account on the signed official list, which acts as the `ace` publisher.
 * Put the account there first with `ace market official add ACCOUNT --key KEY_FILE`. Every
 * version published as `ace` is then held for a maintainer: `ace market review`, approve, then
 * `ace market sign`. With ACE_MARKET_SIGNER_TOKEN set it also uploads the seed's categories. The
 * owner runs this; tests never do.
 */

const [address] = process.argv.slice(2);
const grant = process.env["ACE_MARKET_GRANT"];
const signerToken = process.env["ACE_MARKET_SIGNER_TOKEN"];
if (!address || !grant) {
  console.error("Usage: ACE_MARKET_GRANT=<grant> node scripts/seed.ts <market address>");
  process.exit(2);
}
const base = new URL(address);
if (base.protocol !== "https:" && base.hostname !== "127.0.0.1" && base.hostname !== "localhost") {
  console.error("The market address must be https.");
  process.exit(2);
}

// Only accounts on the official list publish as `ace`; without one there is nothing to seed as.
const official = await fetch(new URL("/v1/official", base));
if (!official.ok) {
  console.error(
    "The market has no official list yet. Run `ace market official add <account> --key <key file>` first.",
  );
  process.exit(2);
}

let failed = 0;
for (const seed of await readSeed()) {
  // An official account publishes as `ace` whatever it names; it names nothing.
  const params = new URLSearchParams({ version: seed.version });
  const url = new URL(`/v1/publish/${seed.type}/${seed.name}/versions?${params}`, base);
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${grant}`, "content-type": "application/x-tar" },
    body: writeArchive(seed.files),
  });
  const said =
    response.status === 201
      ? "stored"
      : response.status === 200
        ? "already stored"
        : await response.text();
  if (response.status !== 201 && response.status !== 200) failed++;
  console.log(`${response.status} ${seed.type}/${seed.name} ${seed.version}: ${said}`);
}

if (signerToken) {
  const categories = JSON.parse(
    await readFile(join(seedRoot, "categories.json"), "utf8"),
  ) as unknown;
  const response = await fetch(new URL("/v1/signer/categories", base), {
    method: "PUT",
    headers: { authorization: `Bearer ${signerToken}`, "content-type": "application/json" },
    body: JSON.stringify(categories),
  });
  if (!response.ok) failed++;
  console.log(`${response.status} categories`);
}
process.exit(failed === 0 ? 0 : 1);
