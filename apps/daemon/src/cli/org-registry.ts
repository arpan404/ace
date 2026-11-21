import { shippedMarketKeys } from "@ace/marketplace";
import { MarketOrgId } from "@ace/protocol/marketplace";
import { option, type Args } from "./args.ts";
import { print } from "./io.ts";
import { marketUrl } from "./market/maintainer-io.ts";
import { signerCodeChecker } from "./market/sign-code.ts";
import { signerTestRunner } from "./market/sign-tests.ts";
import { CliFailure, usageFailure } from "./output.ts";
import { osKeychain } from "../org-registry/keychain.ts";
import {
  freshSeed,
  makeRegistryKey,
  signRegistry,
  type RegistrySignerDeps,
} from "../org-registry/signer.ts";

/*
 * `ace org registry key|sign` (ADR 0206 §5.2): the organization's registry key in this machine's
 * keychain, and its signer. Both run here, in the CLI's own process: the key never reaches the
 * daemon, a socket or a file.
 */

function orgOf(args: Args): string {
  const org = MarketOrgId.safeParse(option(args, "org"));
  if (!org.success)
    throw usageFailure("Name the organization with --org org_….", { argument: "--org" });
  return org.data;
}

function deps(args: Args): RegistrySignerDeps {
  const base = marketUrl(args);
  return {
    keychain: osKeychain(),
    fetch: (path, init) => fetch(new URL(path, base), init),
    now: () => Date.now(),
    trusted: shippedMarketKeys,
  };
}

const failed = (error: unknown) =>
  new CliFailure("refused", error instanceof Error ? error.message : String(error));

export async function registryKeyCommand(args: Args): Promise<void> {
  const org = orgOf(args);
  const owner = option(args, "owner");
  if (!owner)
    throw usageFailure("Name the owner who will publish the key with --owner.", {
      argument: "--owner",
    });
  const made = await makeRegistryKey(deps(args), {
    org,
    owner,
    rotate: args.flags.rotate === true,
    seed: freshSeed(),
  }).catch((error: unknown) => {
    throw failed(error);
  });
  await print(args, { org, ...made });
}

export async function registrySignCommand(args: Args): Promise<void> {
  const org = orgOf(args);
  const report = await signRegistry(
    {
      ...deps(args),
      // A bot package's tests and components are read by Spade's program, as ace's signer does.
      testBot: await signerTestRunner(process.env, process.argv[1]),
      checkCode: await signerCodeChecker(process.env, process.argv[1]),
    },
    org,
  ).catch((error: unknown) => {
    throw failed(error);
  });
  await print(args, report);
  if (report.failed.length > 0)
    throw new CliFailure("failed", "Some signatures weren't taken by the market");
}
