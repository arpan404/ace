import { videoExtensionId } from "./video-extension.ts";

/**
 * Command line for ace's own Chrome. Pure, so the launch contract is testable without a browser.
 *
 * - The pipe replaces a debugging port: nothing listens on TCP and no DevToolsActivePort is written.
 * - Extension debugging is what lets the CDP Extensions domain load unpacked extensions later.
 * - Pages render while unseen: ace's tabs live in hidden headless windows that are never focused.
 * - The device scale factor is process-wide: per-tab emulation does not raise screencast resolution.
 * - No sound reaches the daemon machine's speakers: audio output goes to a fake device, so a page
 *   here (an agent's, or one nobody watches) is never heard there. Not `--mute-audio`: a muted
 *   page's sound reaches tab capture as silence, and remote viewers can unmute (ADR 0088, Audio).
 */
export function chromeArgs(options: {
  profileDir: string;
  deviceScaleFactor: number;
  platform: NodeJS.Platform;
  extra?: readonly string[];
}): string[] {
  if (!Number.isFinite(options.deviceScaleFactor) || options.deviceScaleFactor < 1)
    throw new Error("Invalid browser device scale factor");
  return [
    "--headless=new",
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    `--user-data-dir=${options.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--no-startup-window",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-audio-output",
    // ace's video extension may capture tabs without a click on it (ADR 0088).
    `--allowlisted-extension-id=${videoExtensionId}`,
    ...(options.platform === "darwin" ? ["--use-mock-keychain"] : []),
    ...(options.platform === "linux" ? ["--password-store=basic"] : []),
    ...(options.deviceScaleFactor === 1
      ? []
      : [`--force-device-scale-factor=${options.deviceScaleFactor}`]),
    ...(options.extra ?? []),
  ];
}
