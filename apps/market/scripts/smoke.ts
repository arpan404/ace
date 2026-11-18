/**
 * Checks a deployed market without an account and without writing anything: the Worker answers,
 * the index parses as devices read it (and revalidates), and an install's path works end to end
 * (entry page, signed manifest, archive) using HEAD for the archive, so no download is counted.
 * Publishing without a grant is refused.
 *
 *   node apps/market/scripts/smoke.ts https://market.acehq.dev
 *
 * Against market.acehq.dev the manifest must verify with the keys this build ships and the
 * catalog must list something. Elsewhere (staging) ACE_MARKET_KEYS, the market's public keys as
 * JSON, verifies manifests, and an empty catalog only skips the install path.
 */
import {
  marketOrigin,
  parseIndex,
  shippedMarketKeys,
  verifyManifest,
  verifyWithdrawn,
  type FeedEntry,
} from "@ace/marketplace";
import {
  installableMarketTypes,
  MarketKeySet,
  Signed,
  VersionManifest,
} from "@ace/protocol/marketplace";

const argument = process.argv[2];
if (!argument) throw new Error("Usage: smoke.ts https://market.example.com");
const origin = new URL(argument).origin;
const production = origin === marketOrigin;
const keys = production
  ? shippedMarketKeys
  : process.env.ACE_MARKET_KEYS
    ? MarketKeySet.parse(JSON.parse(process.env.ACE_MARKET_KEYS))
    : undefined;
const signal = AbortSignal.timeout(30_000);
let failed = false;

async function check(name: string, run: () => Promise<void | string>) {
  try {
    const note = await run();
    console.log(`ok    ${name}${note ? ` (${note})` : ""}`);
  } catch (error) {
    failed = true;
    console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function json(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, { ...init, signal });
  if (!response.ok) throw new Error(`${path}: status ${response.status}`);
  return response.json();
}

/** A manifest's body: verified when there are keys, otherwise only read. */
function manifestOf(signed: unknown): VersionManifest {
  if (keys) return verifyManifest(signed, keys);
  return VersionManifest.parse(Signed.parse(signed).body);
}

await check("the Worker answers", async () => {
  const body = await json("/");
  if (JSON.stringify(body) !== '{"name":"ace market","api":"/v1"}')
    throw new Error(`unexpected body ${JSON.stringify(body)}`);
});

await check("a path outside the API is a JSON 404", async () => {
  const response = await fetch(`${origin}/smoke-check-missing`, { signal });
  await response.body?.cancel();
  if (response.status !== 404) throw new Error(`status ${response.status}`);
});

let entries: FeedEntry[] = [];
await check("the index parses as devices read it, and revalidates", async () => {
  // Uncompressed: Cloudflare weakens the ETag of a compressed answer (W/"…").
  const identity = { "accept-encoding": "identity" };
  const response = await fetch(`${origin}/v1/index`, { headers: identity, signal });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const etag = response.headers.get("etag");
  entries = parseIndex(await response.json()).entries;
  if (!etag) throw new Error("no ETag");
  const again = await fetch(`${origin}/v1/index`, {
    headers: { ...identity, "if-none-match": etag },
    signal,
  });
  await again.body?.cancel();
  if (again.status !== 304) throw new Error(`revalidation answered ${again.status}, not 304`);
  return `${entries.length} entries`;
});

await check("categories and featured answer", async () => {
  await json("/v1/categories");
  await json("/v1/featured");
});

await check("the withdrawn list is signed, if there is one", async () => {
  const response = await fetch(`${origin}/v1/withdrawn`, { signal });
  if (response.status === 404) {
    await response.body?.cancel();
    return "none yet";
  }
  if (!response.ok) throw new Error(`status ${response.status}`);
  const body: unknown = await response.json();
  if (keys) verifyWithdrawn(body, keys);
  else Signed.parse(body);
});

const installable = entries.find(
  (entry) =>
    entry.version !== undefined &&
    (installableMarketTypes as readonly string[]).includes(entry.type),
);
if (!installable && production) {
  failed = true;
  console.log("FAIL  the catalog lists an installable entry: none listed");
} else if (!installable) {
  console.log("skip  the install path: the catalog lists nothing yet");
} else {
  const { type, name, version = "" } = installable;
  await check(`${type}/${name}@${version} installs: entry, signed manifest, archive`, async () => {
    await json(`/v1/entries/${type}/${name}`);
    const signed = await json(`/v1/entries/${type}/${name}/${version}`);
    const manifest = manifestOf(
      typeof signed === "object" && signed !== null && "manifest" in signed
        ? signed.manifest
        : undefined,
    );
    if (manifest.type !== type || manifest.name !== name || manifest.version !== version)
      throw new Error("the manifest names another version");
    const archive = await fetch(`${origin}/v1/objects/${manifest.hash}`, {
      method: "HEAD",
      signal,
    });
    if (archive.status !== 200) throw new Error(`archive HEAD answered ${archive.status}`);
    if (archive.headers.get("etag") !== `"${manifest.hash}"`)
      throw new Error("the archive's ETag isn't its hash");
    return keys ? "signature verified" : "signature not checked: no ACE_MARKET_KEYS";
  });
}

await check("publishing without a grant is refused", async () => {
  const response = await fetch(`${origin}/v1/publish/suit/smoke-check/versions?version=0.0.1`, {
    method: "POST",
    signal,
  });
  await response.body?.cancel();
  if (response.status !== 401) throw new Error(`status ${response.status}, expected 401`);
});

process.exitCode = failed ? 1 : 0;
