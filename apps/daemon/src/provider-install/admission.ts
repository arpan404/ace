import { version as openCodeAdmits, versionRefusal } from "@ace/adapter-opencode/contract";
import {
  checkCli,
  cliTooOldMessage,
  cliRequirements,
  providerCli,
} from "@ace/provider-kit/cli-requirements";
import type { ProviderInstallPlan } from "@ace/protocol";

/**
 * Why a just-installed CLI is one ace would then refuse to start, or undefined when ace admits
 * it. Installers fetch the vendor's latest release, so a release older than ace's minimum (a
 * stale mirror or cask) or a new line ace hasn't checked must say so instead of reporting
 * success. Pure.
 */
export function installRefusal(
  plan: Pick<ProviderInstallPlan, "provider" | "action">,
  version: string,
): string | undefined {
  if (plan.action === "uninstall") return undefined;
  const cli = providerCli(plan.provider);
  const check = cli && checkCli(cli, version);
  if (cli && check?.status === "too_old")
    return `Installed, but ace can't use this version. ${cliTooOldMessage(cliRequirements[cli].name, check.installed, check.required)}`;
  if (plan.provider === "opencode" && !openCodeAdmits(version))
    return `Installed, but ace can't use this version yet. ${versionRefusal(version).message}.`;
  return undefined;
}
