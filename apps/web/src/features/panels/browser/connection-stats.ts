import { useDeviceToggle } from "./device-toggle.ts";

/**
 * "Show connection stats" (Settings › Browser › In this window): whether the browser's ⋯ menu
 * shows how long the person's input takes to reach the page and come back. Off unless turned on.
 */
export function useConnectionStatsShown(): [boolean, (value: boolean) => void] {
  return useDeviceToggle("ace.browser.connectionStats", false);
}
