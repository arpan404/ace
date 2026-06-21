import type { ReactNode } from "react";
import type { ServerProvider } from "@ace/contracts";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function maskEmailAddress(value: string): string {
  const [localPart, domainPart] = value.split("@");
  if (!localPart || !domainPart) {
    return value;
  }

  const maskedLocal =
    localPart.length <= 2
      ? `${localPart[0] ?? ""}*`
      : `${localPart.slice(0, 2)}${"*".repeat(Math.max(3, localPart.length - 3))}${
          localPart.slice(-1) || ""
        }`;

  const domainSegments = domainPart.split(".");
  const domainName = domainSegments[0] ?? "";
  const domainSuffix = domainSegments.slice(1).join(".");
  const maskedDomainName =
    domainName.length <= 1
      ? "*"
      : `${domainName[0]}${"*".repeat(Math.max(2, domainName.length - 1))}`;

  return domainSuffix.length > 0
    ? `${maskedLocal}@${maskedDomainName}.${domainSuffix}`
    : `${maskedLocal}@${maskedDomainName}`;
}

function renderAuthLabel(provider: ServerProvider): ReactNode {
  const authLabel = provider.auth.label ?? provider.auth.type;
  if (!authLabel) {
    return null;
  }

  if (provider.provider === "cursor" && authLabel.includes("@")) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span className="cursor-help">{maskEmailAddress(authLabel)}</span>}
        />
        <TooltipPopup side="top">{authLabel}</TooltipPopup>
      </Tooltip>
    );
  }

  return authLabel;
}

export function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return {
      headline: "Checking provider status",
      detail: "Waiting for the server to report installation and authentication details.",
    };
  }
  if (!provider.enabled) {
    return {
      headline: "Disabled",
      detail:
        provider.message ?? "This provider is installed but disabled for new sessions in ace.",
    };
  }
  if (!provider.installed) {
    return {
      headline: "Not found",
      detail: provider.message ?? "CLI not detected on PATH.",
    };
  }
  if (provider.versionStatus === "upgrade-required") {
    return {
      headline: "Upgrade needed",
      detail:
        provider.message ??
        (provider.minimumVersion
          ? `Installed CLI is below the minimum supported version ${getProviderVersionLabel(provider.minimumVersion)}.`
          : "Installed CLI is below the minimum supported version."),
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = renderAuthLabel(provider);
    return {
      headline: authLabel ? <>Authenticated · {authLabel}</> : "Authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      headline: "Not authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail:
        provider.message ?? "The provider is installed, but the server could not fully verify it.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Unavailable",
      detail: provider.message ?? "The provider failed its startup checks.",
    };
  }
  return {
    headline: "Available",
    detail: provider.message ?? "Installed and ready, but authentication could not be verified.",
  };
}

export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}
