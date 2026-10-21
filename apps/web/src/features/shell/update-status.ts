import type { UpdateStatus } from "@/boot/desktop-updates.ts";

/** What a click on the update button does. */
export type UpdateAction = "check" | "download" | "open-release" | "install" | "none";

export function updateAction(status: UpdateStatus): UpdateAction {
  switch (status.state) {
    case "idle":
    case "current":
    case "error":
      return "check";
    case "available":
      return status.inPlace ? "download" : "open-release";
    case "downloaded":
      return "install";
    default:
      return "none";
  }
}

const agents = (count: number) => (count === 1 ? "1 agent finishes" : `${count} agents finish`);

/** The button's name and tooltip: where the update stands and what a click does. */
export function updateLabel(status: UpdateStatus): string {
  const version = status.version ?? "";
  switch (status.state) {
    case "disabled":
      return "Automatic updates are not available in this build";
    case "idle":
      return "Check for updates";
    case "checking":
      return "Checking for updates…";
    case "current":
      return `ace ${status.currentVersion} is up to date`;
    case "error":
      return "Couldn't check for updates. Click to try again.";
    case "available":
      if (status.error?.during === "download")
        return `Download failed for ${version}. Click to retry.`;
      return status.inPlace
        ? `Update ${version} ready to download`
        : `Update ${version} available. Click to download it from GitHub.`;
    case "downloading":
      return `Downloading update (${Math.floor(status.percent ?? 0)}%)`;
    case "downloaded":
      return status.error?.during === "install"
        ? "Agents are still working. Click to restart once they finish."
        : `Update ${version} downloaded. Click to restart and install.`;
    case "installing":
      return status.waiting > 0
        ? `Updating when ${agents(status.waiting)}`
        : "Restarting to update…";
  }
}

/** Whether there is an update in hand, which the button shows as such. */
export function hasUpdate(status: UpdateStatus): boolean {
  return (
    status.version !== null &&
    ["available", "downloading", "downloaded", "installing"].includes(status.state)
  );
}

/** Hovering shows what changed, when the update in hand came with release notes. */
export function showsReleaseNotes(status: UpdateStatus): boolean {
  return hasUpdate(status) && status.notes.some((note) => note.items.length > 0);
}
