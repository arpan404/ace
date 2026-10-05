import { checkRelease, isNewer, releaseFetch } from "@ace/service";
import type { UpdateStatus } from "../../shared/contract.ts";
import { repositoryUrl } from "../links.ts";

/** Replaced at build time with the release authority's Ed25519 public key (ADR 0041). */
declare const ACE_RELEASE_PUBLIC_KEY: string;
const feed = "https://api.github.com/repos/arpan404/ace/releases/latest";

/**
 * Checks the signed release feed. The manifest is verified with the public key embedded at
 * build time, never one from the feed; a build without a key (local unsigned builds) fails
 * closed. ace's daemon and desktop app share one version, so the signed daemon manifest for
 * this platform authenticates the new version, and the installer is offered from its release.
 */
export async function checkForUpdate(current: string): Promise<UpdateStatus> {
  const key = typeof ACE_RELEASE_PUBLIC_KEY === "string" ? ACE_RELEASE_PUBLIC_KEY : "";
  if (!key.includes("BEGIN PUBLIC KEY"))
    return { state: "error", message: "Updates are not configured for this build" };
  const target = `${process.platform}-${process.arch}`;
  if (!/^(darwin|linux)-(arm64|x64)$/.test(target))
    return { state: "error", message: `No signed releases for ${target} yet` };
  try {
    const channel = current.includes("-") ? "preview" : "stable";
    const release = await checkRelease(releaseFetch, feed, target, channel, key);
    if (!isNewer(release.manifest.version, current)) return { state: "current", version: current };
    return {
      state: "available",
      version: release.manifest.version,
      url: `${repositoryUrl}/releases/tag/v${release.manifest.version}`,
    };
  } catch (error) {
    return { state: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
