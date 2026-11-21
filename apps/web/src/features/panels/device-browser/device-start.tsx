import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { AddressSuggestion } from "@ace/ui-core";
import { useWorkspaceActions, type TabViewProps } from "@/lib/workspace/index.ts";
import { usePanelServices } from "../services.ts";
import { browserTabData } from "../browser/browser-data.ts";
import { AddressBar } from "../browser/address-bar.tsx";
import { PageNav, PageToolbar } from "../browser/page-toolbar.tsx";
import { StartPage } from "../browser/page-states.tsx";
import { deviceTabRequest } from "./device-data.ts";

/**
 * A new browser tab on another machine's thread, in the desktop app (ADR 0194): the address the
 * person enters, picks or followed a link to opens as a device tab in its place, running on this
 * computer with the machine's `localhost`. The machine's dev servers are suggested at their
 * `localhost` ports.
 */
export function DeviceStart(props: TabViewProps & { machine: string }) {
  const { scope, tab, machine } = props;
  const actions = useWorkspaceActions(scope);
  const { preview: source } = usePanelServices();
  const subscribe = useCallback(
    (changed: () => void) => source.subscribe(changed, scope),
    [source, scope],
  );
  useSyncExternalStore(subscribe, () => source.version);
  const open = (url: string) =>
    actions.replace(tab.key, deviceTabRequest(machine, url, crypto.randomUUID()));
  // Opened with an address (the launcher's bar, a link): it opens at once.
  const pending = browserTabData(tab).open;
  useEffect(() => {
    if (pending && /^https?:\/\//i.test(pending)) open(pending);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the address is what matters.
  }, [pending]);
  const suggestions: AddressSuggestion[] = source.servers(scope).map((server) => ({
    url: `http://localhost:${server.port}`,
    label: server.name ?? `localhost:${server.port}`,
    detail: `Dev server · port ${server.port}`,
  }));
  return (
    <div data-browser-tab="" className="relative flex h-full min-h-0 flex-col">
      <PageToolbar
        nav={<PageNav back={{}} forward={{}} reload={{}} loading={false} />}
        address={
          <AddressBar
            url={undefined}
            known={suggestions}
            loading={false}
            autoFocus
            placeholder="Search or enter a URL"
            onGo={open}
          />
        }
      />
      <div data-browser-page="" className="relative min-h-0 flex-1 overflow-auto">
        <StartPage suggestions={suggestions} onGo={open} />
      </div>
    </div>
  );
}
