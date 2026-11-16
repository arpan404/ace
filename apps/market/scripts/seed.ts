import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeArchive } from "@ace/marketplace";
import { readSeed, seedRoot } from "../src/seed/folders.ts";

/*
 * Publishes the seed to a market: `node scripts/seed.ts https://market.acehq.dev`, with a market
 * publishing grant for ace's own account in ACE_MARKET_GRANT (it lasts five minutes). Each
 * version then waits for the signer. With ACE_MARKET_SIGNER_TOKEN set it also uploads the
 * seed's categories. The owner runs this; tests never do.
 */

const [address] = process.argv.slice(2);
const grant = process.env["ACE_MARKET_GRANT"];
const publisher = process.env["ACE_MARKET_PUBLISHER"] ?? "ace";
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

let failed = 0;
for (const seed of await readSeed()) {
  const params = new URLSearchParams({ version: seed.version, publisher });
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
