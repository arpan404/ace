import { version as openCodeAdmits, versionRefusal } from "@ace/adapter-opencode/contract";
import { piVersionRefusal, piVersionSupported } from "@ace/provider-kit/discovery";
import type { ProviderInstallPlan } from "@ace/protocol";

/**
 * Why a just-installed CLI is one ace would then refuse to start, or undefined when ace admits
 * it. Installers fetch the vendor's latest release, so a new line can land before ace has checked
 * it; the install must then say so instead of reporting success. Pure.
 */
export function installRefusal(
  plan: Pick<ProviderInstallPlan, "provider" | "action">,
  version: string,
): string | undefined {
  if (plan.action === "uninstall") return undefined;
  const refusal =
    plan.provider === "opencode" && !openCodeAdmits(version)
      ? versionRefusal(version).message
      : plan.provider === "pi" && !piVersionSupported(version)
        ? piVersionRefusal(version)
        : undefined;
  return refusal && `Installed, but ace can't use this version yet. ${refusal}.`;
}
