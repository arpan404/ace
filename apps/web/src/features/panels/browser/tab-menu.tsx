import { MenuItem } from "@/components/ui/menu.tsx";
import type { WorkspaceTab } from "@/lib/workspace/index.ts";
import { useLoadedServices } from "../services.ts";
import { daemonTabId } from "./browser-data.ts";
import { useDaemonTab } from "./tab-mark.tsx";
import { useBrowserFeatures } from "./use-browser-features.ts";

/** A browser tab's own right-click items: mute or unmute it, as in a browser. */
export function BrowserTabMenuItems(props: { scope: string; tab: WorkspaceTab }) {
  const source = useLoadedServices()?.preview;
  const tab = useDaemonTab(source, props.scope, daemonTabId(props.tab));
  const browser = useBrowserFeatures(props.scope);
  // A new tab's start page has no page behind it yet.
  if (!tab) return null;
  return (
    <MenuItem onClick={() => void browser.muteTab(tab.tabId, !tab.muted)}>
      {tab.muted ? "Unmute tab" : "Mute tab"}
    </MenuItem>
  );
}
