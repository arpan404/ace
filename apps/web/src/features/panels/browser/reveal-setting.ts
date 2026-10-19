import { useDeviceToggle } from "./device-toggle.ts";

/**
 * "Open the browser panel when an agent opens a page" (Settings › Browser), kept current. Off
 * unless turned on, on every screen size: an agent's page still arrives as a Browser tab and its
 * transcript row opens it, but the panel stays as the person left it.
 */
export function useRevealAgentPages(): [boolean, (value: boolean) => void] {
  return useDeviceToggle("ace.browser.agentPages.reveal", false);
}
