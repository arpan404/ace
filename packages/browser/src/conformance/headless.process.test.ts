import { BrowserService } from "../service.ts";
import { detectChromium } from "../discovery.ts";
import { defineBrowserConformance } from "./suite.ts";

/** ace's own Chrome for Testing over a pipe (ADR 0083), as the daemon runs it without a desktop. */
const executablePath = process.env.ACE_CHROMIUM_PATH ?? (await detectChromium());

defineBrowserConformance({
  name: "ace's Chrome (headless)",
  unavailable: executablePath ? undefined : "no Chromium found; set ACE_CHROMIUM_PATH",
  start: async ({ options }) =>
    new BrowserService({
      ...options,
      ...(executablePath ? { executablePath } : {}),
      backendPreference: () => "headless",
      tabLifecycle: false,
      ffmpeg: "",
    }),
});
