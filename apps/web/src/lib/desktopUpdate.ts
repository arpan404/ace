import type { DesktopUpdateActionResult, DesktopUpdateState } from "@ace/contracts";

export const DESKTOP_UPDATE_FALLBACK_DOWNLOAD_URL =
  "https://github.com/arpan404/ace/releases/latest";

export type DesktopUpdateButtonAction = "download" | "install" | "external-download" | "none";

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (state.status === "installing") {
    return "none";
  }
  if (state.errorContext === "install" && state.downloadedVersion) {
    return state.canRetry ? "install" : "external-download";
  }
  if (state.downloadedVersion) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowDesktopUpdateButton(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) {
    return false;
  }
  if (state.status === "downloading" || state.status === "installing") {
    return true;
  }
  return resolveDesktopUpdateButtonAction(state) !== "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading" || state?.status === "installing";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "This install is using the correct architecture.";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return "This Mac has Apple Silicon, but ace is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.";
  }
  if (action === "install") {
    return "This Mac has Apple Silicon, but ace is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.";
  }
  return "This Mac has Apple Silicon, but ace is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.";
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (state.errorContext === "download" && state.availableVersion) {
    return (
      state.message?.trim() || `Download failed for ${state.availableVersion}. Click to retry.`
    );
  }
  if (state.errorContext === "install" && state.downloadedVersion) {
    return (
      state.message?.trim() || `Install failed for ${state.downloadedVersion}. Click to retry.`
    );
  }
  if (state.status === "available") {
    return `Update ${state.availableVersion ?? "available"} ready to download`;
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return `Downloading update${progress}`;
  }
  if (state.status === "installing") {
    return state.message ?? "Restarting to install update";
  }
  if (state.status === "downloaded") {
    return `Update ${state.downloadedVersion ?? state.availableVersion ?? "ready"} downloaded. Click to restart and install.`;
  }
  if (state.status === "error") {
    return state.message ?? "Update failed";
  }
  return "Up to date";
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
  runningAgentCount = 0,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  const runningAgentWarning =
    runningAgentCount > 0
      ? `\n\n${runningAgentCount === 1 ? "1 agent is" : `${String(runningAgentCount)} agents are`} running in the background. Continuing will stop ${runningAgentCount === 1 ? "that agent" : "those agents"} before the update installs.`
      : "";
  return `Install update${version ? ` ${version}` : ""} and restart ace?\n\nThis will update the desktop app, bundled web UI, server daemon runtime, and \`ace\` CLI command.${runningAgentWarning}\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.`;
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (result.state.errorContext !== "download" && result.state.errorContext !== "install") {
    return null;
  }
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function shouldHighlightDesktopUpdateError(state: DesktopUpdateState | null): boolean {
  if (!state || state.status !== "error") return false;
  return state.errorContext === "download" || state.errorContext === "install";
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" &&
    state.status !== "downloading" &&
    state.status !== "installing" &&
    state.status !== "downloaded" &&
    state.status !== "disabled"
  );
}
