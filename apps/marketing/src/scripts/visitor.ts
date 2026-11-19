import type { Arch, Platform } from "../content/release-pick.ts";

/*
 * Which computer the visitor is on, from what their browser says. Pure, so the rules are tested
 * without a browser; latest-release.ts feeds it navigator's values.
 */

/** The visitor's desktop system, or undefined on a phone, tablet or anything unknown. */
export function platformOf(userAgent: string): Platform | undefined {
  if (/Android|iPhone|iPad|iPod/.test(userAgent)) return undefined;
  if (/Windows/.test(userAgent)) return "windows";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "mac";
  if (/Linux|X11|CrOS/.test(userAgent)) return "linux";
  return undefined;
}

/** What Chromium's client hints report (navigator.userAgentData.getHighEntropyValues). */
export interface ChipHints {
  architecture?: string;
  bitness?: string;
}

/**
 * The visitor's chip, or undefined when the browser doesn't say (Safari and Firefox on a Mac
 * report "Intel" whatever the chip). Client hints win; a Linux user agent names its chip too.
 */
export function archOf(hints: ChipHints | undefined, userAgent: string): Arch | undefined {
  if (hints?.architecture === "arm") return "arm64";
  if (hints?.architecture === "x86" && hints.bitness === "64") return "x64";
  if (/aarch64|arm64/i.test(userAgent)) return "arm64";
  if (/x86_64|Win64|WOW64/.test(userAgent)) return "x64";
  return undefined;
}
