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
import { option, type Args } from "../args.ts";
import { CliFailure } from "../output.ts";

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

export function marketUrl(args: Args): URL {
  const url = new URL(option(args, "url") ?? marketOrigin);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    throw new CliFailure("refused", "The market is reached over https only");
  return url;
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

export function signerIo(base: URL): SignerIo {
  const token = signerToken();
  const headers = { authorization: `Bearer ${token}` };
  return {
    get: async (path) => (await answered(await fetch(new URL(path, base), { headers }))).json(),
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
