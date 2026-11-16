import { lstat, opendir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { decodeBase64url, encodeBase64url } from "@ace/account-grant";
import { MarketEntryName, MarketEntryType } from "@ace/protocol/marketplace";
import {
  marketOrigin,
  marketPublicKey,
  shippedMarketKeys,
  type MarketKeySet,
  marketSigningKey,
  type ArchiveFile,
  type MarketSigningKey,
} from "@ace/marketplace";
import { checkFiles } from "@ace/marketplace/checks";
import { signPending, signReview, type SignerIo } from "@ace/marketplace/signer";
import { option, validateArgs, type Args } from "./args.ts";
import { print } from "./io.ts";
import { CliFailure } from "./output.ts";

/*
 * The marketplace's maintainer tools (ADR 0168 §6, §7), run on a maintainer's machine:
 *
 *   ace market keygen KEY_FILE [--id ID]          a signing key in a file; prints its public half
 *   ace market sign --key KEY_FILE [--url URL]    sign every pending version that passes again
 *   ace market review TYPE/NAME@VERSION --key KEY_FILE [--by-ace] [--not-reviewed] [--url URL]
 *   ace market feature TYPE/NAME ... [--url URL]  the featured list (reviewed entries only)
 *   ace marketplace check PATH --type TYPE [--name NAME]   the publish checks on a folder
 *
 * The signer's token comes from ACE_MARKET_SIGNER_TOKEN; the key only ever from its file.
 */

const KeyFile = z.object({ id: z.string(), privateKey: z.string() });

async function readKey(path: string | undefined): Promise<MarketSigningKey> {
  if (!path) throw new CliFailure("refused", "Pass the signing key's file with --key");
  const info = await lstat(path);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    throw new CliFailure("refused", `${path} can be read by others; chmod 600 it first`);
  const file = KeyFile.parse(JSON.parse(await readFile(path, "utf8")));
  return marketSigningKey(file.id, decodeBase64url(file.privateKey));
}

function marketUrl(args: Args): URL {
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

function signerIo(base: URL): SignerIo {
  const token = process.env["ACE_MARKET_SIGNER_TOKEN"];
  if (!token)
    throw new CliFailure("refused", "Set ACE_MARKET_SIGNER_TOKEN to the market's signer token");
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

/** A folder's regular files, as an archive would hold them; links and other kinds refused. */
async function readFolder(root: string): Promise<ArchiveFile[]> {
  const files: ArchiveFile[] = [];
  const walk = async (folder: string, depth: number) => {
    if (depth > 32) throw new CliFailure("refused", `${folder} is nested too deep`);
    for await (const entry of await opendir(folder)) {
      const path = join(folder, entry.name);
      const name = relative(root, path).split(sep).join("/");
      if (entry.name === ".git") continue;
      if (entry.isSymbolicLink())
        throw new CliFailure("refused", `${name} is a link; an entry holds only its own files`);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile()) {
        const info = await lstat(path);
        files.push({
          path: name,
          executable: (info.mode & 0o111) !== 0,
          content: new Uint8Array(await readFile(path)),
        });
      } else throw new CliFailure("refused", `${name} isn't a regular file`);
    }
  };
  await walk(root, 0);
  return files;
}

const now = () => Date.now();

/**
 * The keys a read-back signature may be by: the ones this build ships and the key signing now,
 * so a list or manifest the previous key signed still verifies after a rotation.
 */
function trustedWith(key: MarketSigningKey): MarketKeySet {
  const active = marketPublicKey(key);
  return {
    keys: [...shippedMarketKeys.keys.filter((known) => known.id !== active.id), active],
  };
}

export async function marketCommand(args: Args): Promise<void> {
  const verb = args.words[1];
  switch (verb) {
    case "keygen": {
      validateArgs(args, ["id"], 3, 3);
      const path = args.words[2] ?? "";
      const key = marketSigningKey(
        option(args, "id") ?? "market-1",
        crypto.getRandomValues(new Uint8Array(32)),
      );
      await writeFile(
        path,
        JSON.stringify({ id: key.id, privateKey: encodeBase64url(key.privateKey) }) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      return print(args, { file: path, publicKey: marketPublicKey(key) });
    }
    case "sign": {
      validateArgs(args, ["key", "url"], 2, 2);
      const key = await readKey(option(args, "key"));
      const report = await signPending(signerIo(marketUrl(args)), key, now, trustedWith(key));
      await print(args, report);
      if (report.failed.length > 0)
        throw new CliFailure("failed", "Some signatures weren't taken by the market");
      return;
    }
    case "review": {
      validateArgs(args, ["key", "url", "by-ace", "not-reviewed"], 3, 3);
      const match = /^([a-z-]+)\/([^@]+)@(.+)$/.exec(args.words[2] ?? "");
      if (!match) throw new CliFailure("refused", "Name the version as TYPE/NAME@VERSION");
      const key = await readKey(option(args, "key"));
      const answer = await signReview(signerIo(marketUrl(args)), key, now, trustedWith(key), {
        type: MarketEntryType.parse(match[1]),
        name: MarketEntryName.parse(match[2]),
        version: match[3] ?? "",
        reviewed: args.flags["not-reviewed"] !== true,
        byAce: args.flags["by-ace"] === true,
      });
      if (answer.status < 200 || answer.status >= 300)
        throw new CliFailure("failed", `The market answered ${answer.status}: ${answer.text}`);
      return print(args, { ok: true });
    }
    case "feature": {
      validateArgs(args, ["url"], 2, 26);
      const entries = args.words.slice(2).map((word) => {
        const [type = "", name = ""] = word.split("/");
        return { type: MarketEntryType.parse(type), name: MarketEntryName.parse(name) };
      });
      const answer = await signerIo(marketUrl(args)).put("/v1/signer/featured", { entries });
      if (answer.status < 200 || answer.status >= 300)
        throw new CliFailure("failed", `The market answered ${answer.status}: ${answer.text}`);
      return print(args, { ok: true, featured: entries.length });
    }
    default:
      throw new CliFailure(
        "refused",
        "Use ace market keygen, sign, review or feature. See ace --help.",
      );
  }
}

/** `ace marketplace check PATH --type TYPE [--name NAME]`: the checks the market runs on upload. */
export async function marketplaceCommand(args: Args): Promise<void> {
  if (args.words[1] !== "check")
    throw new CliFailure("refused", "Use ace marketplace check PATH --type TYPE");
  validateArgs(args, ["type", "name"], 3, 3);
  const root = args.words[2] ?? "";
  const type = MarketEntryType.safeParse(option(args, "type"));
  if (!type.success)
    throw new CliFailure("refused", "Pass --type suit, spade-skill, spade-plugin or spade-bot");
  const name = option(args, "name") ?? root.split(/[\\/]/).findLast(Boolean) ?? "";
  if (!MarketEntryName.safeParse(name).success)
    throw new CliFailure("refused", `${name} isn't an entry name; pass --name`);
  const checked = checkFiles(type.data, name, await readFolder(root));
  const result = {
    type: type.data,
    name,
    hash: checked.hash,
    files: checked.files.length,
    bytes: checked.size,
    listing: checked.listing,
    problems: checked.problems,
  };
  if (checked.problems.length === 0)
    return print(
      args,
      args.flags.json ? result : `${type.data}/${name} passes. Content hash ${checked.hash}.`,
    );
  await print(
    args,
    args.flags.json
      ? result
      : checked.problems
          .map(
            (problem) =>
              `${problem.path ?? name}${problem.line ? `:${problem.line}` : ""}: ${problem.message}`,
          )
          .join("\n"),
  );
  throw new CliFailure(
    "refused",
    `${checked.problems.length} problem${checked.problems.length === 1 ? "" : "s"}`,
  );
}
