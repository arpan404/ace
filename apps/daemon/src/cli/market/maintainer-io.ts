import { lstat, readFile } from "node:fs/promises";
import { z } from "zod";
import { decodeBase64url } from "@ace/account-grant";
import type { MarketKeySet } from "@ace/protocol/marketplace";
import {
  marketOrigin,
  marketPublicKey,
  shippedMarketKeys,
  marketSigningKey,
  type MarketSigningKey,
} from "@ace/marketplace";
import type { SignerIo } from "@ace/marketplace/signer";
import { aceClientName, namedFetch } from "@ace/client/ace-client";
import { option, type Args } from "../args.ts";
import { CliFailure, usageFailure } from "../output.ts";

/* What every maintainer tool shares: the signing key, the market's address and the signer's io. */

/** Every maintainer command's help and first error say what it needs. */
export const maintainerNeeds = "Maintainer tool: needs ACE_MARKET_SIGNER_TOKEN and a signing key.";

const KeyFile = z.object({ id: z.string(), privateKey: z.string() });

export async function readKey(path: string | undefined): Promise<MarketSigningKey> {
  if (!path)
    throw new CliFailure("refused", maintainerNeeds, undefined, {
      code: "refused",
      argument: "--key",
      hint: "Pass the signing key's file with --key.",
    });
  const info = await lstat(path);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    throw new CliFailure("refused", `${path} can be read by others; chmod 600 it first`);
  const file = KeyFile.parse(JSON.parse(await readFile(path, "utf8")));
  return marketSigningKey(file.id, decodeBase64url(file.privateKey));
}

/**
 * Where the maintainer tools send ACE_MARKET_SIGNER_TOKEN: market.acehq.dev, or a development
 * market named on purpose with `--dev-market`. The old `--url` may only name market.acehq.dev,
 * so a mistyped or planted origin never receives the token.
 */
export function marketUrl(args: Args): URL {
  const dev = option(args, "dev-market");
  if (dev !== undefined) {
    const url = parsed(dev, "--dev-market");
    const loopback =
      url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      throw usageFailure("--dev-market takes an https origin, or http on this machine.", {
        argument: "--dev-market",
      });
    return url;
  }
  const named = option(args, "url");
  const url = new URL(marketOrigin);
  if (named !== undefined && parsed(named, "--url").origin !== url.origin)
    throw usageFailure(`The signer token goes only to ${url.host}, not ${named}.`, {
      argument: "--url",
      hint: "For a development market, name it with --dev-market URL.",
    });
  return url;
}

function parsed(value: string, flag: string): URL {
  try {
    return new URL(value);
  } catch {
    throw usageFailure(`${flag} takes a URL, like https://market.example.`, { argument: flag });
  }
}

async function answered(response: Response): Promise<Response> {
  if (!response.ok)
    throw new CliFailure(
      "failed",
      `The market answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  return response;
}

/** The signer's token, or the maintainer tools' first error: what they need. */
export function signerToken(): string {
  const token = process.env["ACE_MARKET_SIGNER_TOKEN"];
  if (!token)
    throw new CliFailure("refused", maintainerNeeds, undefined, {
      code: "refused",
      hint: "Set ACE_MARKET_SIGNER_TOKEN to the market's signer token.",
    });
  return token;
}

/** `fetch` naming this CLI to the market (`ace-client`, ADR 0189), once its version is read. */
function cliFetch(): (url: URL, init?: RequestInit) => Promise<Response> {
  // Read as `ace --version` reads it, and only when a maintainer tool runs.
  const name = import("../../doctor/install.ts")
    .then(({ cliVersion }) => cliVersion(process.env, process.argv[1]))
    .then(
      (version) => aceClientName("cli", version),
      () => undefined,
    );
  return async (url, init) => namedFetch(fetch, await name)(url, init);
}

export function signerIo(base: URL): SignerIo {
  const token = signerToken();
  const headers = { authorization: `Bearer ${token}` };
  const fetch = cliFetch();
  return {
    get: async (path) => (await answered(await fetch(new URL(path, base), { headers }))).json(),
    // A read route the market has nothing at (a package never published) is no error.
    read: async (path) => {
      const response = await fetch(new URL(path, base), { headers });
      if (response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      return (await answered(response)).json();
    },
    object: async (hash) =>
      new Uint8Array(
        await (
          await answered(await fetch(new URL(`/v1/signer/objects/${hash}`, base), { headers }))
        ).arrayBuffer(),
      ),
    put: async (path, body) => {
      const response = await fetch(new URL(path, base), {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, text: (await response.text()).slice(0, 2000) };
    },
  };
}

export const now = () => Date.now();

/**
 * The keys a read-back signature may be by: the ones this build ships and the key signing now,
 * so a list or manifest the previous key signed still verifies after a rotation.
 */
export function trustedWith(key: MarketSigningKey): MarketKeySet {
  const active = marketPublicKey(key);
  return {
    keys: [...shippedMarketKeys.keys.filter((known) => known.id !== active.id), active],
  };
}
