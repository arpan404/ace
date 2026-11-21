import { writeFile } from "node:fs/promises";
import { encodeBase64url } from "@ace/account-grant";
import { MarketEntryName, MarketEntryType } from "@ace/protocol/marketplace";
import { marketPublicKey, marketSigningKey } from "@ace/marketplace";
import { signPending, signRevocation } from "@ace/marketplace/signer";
import { option, validateArgs, type Args } from "../args.ts";
import { print } from "../io.ts";
import { CliFailure } from "../output.ts";
import { maintainerWork } from "./maintainer-queue.ts";
import { signerTestRunner } from "./sign-tests.ts";
import { signerCodeChecker } from "./sign-code.ts";
import { marketUrl, now, readKey, signerIo, signerToken, trustedWith } from "./maintainer-io.ts";

/*
 * The marketplace's maintainer tools (ADR 0168 §6, §7; ADR 0178 §12.6), run on a maintainer's
 * machine under the hidden `ace market maintainer VERB` (old `ace market VERB` spellings stay for
 * the deprecation window):
 *
 *   keygen KEY_FILE [--id ID]          a signing key in a file; prints its public half
 *   sign --key KEY_FILE [--url URL]    re-scan and run bot packages' tests, then sign, hold or
 *                                      block what waits; sign any pending withdrawals
 *   review                             what waits for a maintainer, as sentences
 *   review TYPE/NAME@VERSION --show|--approve|--block REASON
 *   review TYPE/NAME@VERSION --key KEY_FILE [--by-ace] [--not-reviewed]
 *   feature TYPE/NAME ... [--url URL]  the featured list (reviewed entries only)
 *   revoke HASH --reason TEXT --key KEY_FILE
 *   reports [resolve ID --state STATE [--note TEXT]]
 *   collection list|put ID --title T --line L TYPE/NAME ...|remove ID
 *   publisher HANDLE --suspend REASON|--restore|--withdraw-all REASON [--key KEY_FILE]
 *   block HASH|block-file SHA256|block-pattern TEXT --reason TEXT --key KEY_FILE
 *   appeals | appeal ID --answer TEXT --approve|--keep
 *   verify|unverify HANDLE --reason TEXT --key KEY_FILE
 *   official add|remove ACCOUNT --key KEY_FILE
 *
 * They are the one part of the CLI that talks to market.acehq.dev directly, never through the
 * daemon or an ace account. The signer's token comes from ACE_MARKET_SIGNER_TOKEN; the key only
 * ever from its file.
 */

/** `args.words` is `[market, VERB, ...]`, as the first CLI spelled them. */
export async function maintainerCommand(args: Args): Promise<void> {
  const verb = args.words[1];
  // Every tool but keygen talks to the market: say what it needs before anything else.
  if (verb !== "keygen") signerToken();
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
      validateArgs(args, ["key", "url", "dev-market"], 2, 2);
      const key = await readKey(option(args, "key"));
      // A bot package's own tests run here, on Spade's program, before it is signed.
      const testBot = await signerTestRunner(process.env, process.argv[1]);
      // A bot package's WebAssembly components are read from their bytes, by Spade's program.
      const checkCode = await signerCodeChecker(process.env, process.argv[1]);
      const report = await signPending(signerIo(marketUrl(args)), key, now, trustedWith(key), {
        testBot,
        checkCode,
      });
      await print(args, report);
      if (report.failed.length > 0)
        throw new CliFailure("failed", "Some signatures weren't taken by the market");
      return;
    }
    case "feature": {
      validateArgs(args, ["url", "dev-market"], 2, 26);
      const entries = args.words.slice(2).map((word) => {
        const [type = "", name = ""] = word.split("/");
        return { type: MarketEntryType.parse(type), name: MarketEntryName.parse(name) };
      });
      const answer = await signerIo(marketUrl(args)).put("/v1/signer/featured", { entries });
      if (answer.status < 200 || answer.status >= 300)
        throw new CliFailure("failed", `The market answered ${answer.status}: ${answer.text}`);
      return print(args, { ok: true, featured: entries.length });
    }
    case "revoke": {
      validateArgs(args, ["key", "url", "dev-market", "reason"], 3, 3);
      const hash = args.words[2] ?? "";
      const reason = option(args, "reason");
      if (!/^[a-f0-9]{64}$/.test(hash))
        throw new CliFailure("refused", "Name the bytes by their content hash");
      if (!reason) throw new CliFailure("refused", "Say why with --reason; devices show it");
      const key = await readKey(option(args, "key"));
      const answer = await signRevocation(signerIo(marketUrl(args)), key, now, trustedWith(key), {
        hash,
        reason,
      });
      if (answer.status < 200 || answer.status >= 300)
        throw new CliFailure("failed", `The market answered ${answer.status}: ${answer.text}`);
      return print(args, { ok: true, revoked: hash });
    }
    default:
      return maintainerWork(verb, args);
  }
}
