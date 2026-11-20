import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { addressHost, displayAddress, type BrowserFailure } from "@ace/ui-core";
import { desktopDeviceTabs } from "@/boot/desktop-device-tabs.ts";
import { Button } from "@/components/ui/button.tsx";
import {
  useScopeWorkspace,
  useWorkspaceActions,
  type TabViewProps,
} from "@/lib/workspace/index.ts";
import { AddressBar } from "../browser/address-bar.tsx";
import { PageNav, PageToolbar } from "../browser/page-toolbar.tsx";
import { deviceTabData, deviceTabRequest } from "./device-data.ts";
import { deviceTabStateOf, subscribeDeviceTab } from "./device-store.ts";
import { deviceTabProblem } from "./device-words.ts";
import { useDevicePlacement } from "./use-device-placement.ts";
import { useTunnelPath } from "./use-tunnel-path.ts";

/**
 * A device tab (ADR 0194): a page the person opened on another machine's thread, running in a
 * native view on this computer, in that machine's own partition. `localhost` is the machine's,
 * through its tunnel; every other host loads from here. Agents don't see or drive it.
 */
export default function DeviceBrowserTab(props: TabViewProps) {
  const { scope, tab } = props;
  const data = deviceTabData(tab);
  const tabs = desktopDeviceTabs();
  const tabId = tab.id;
  const actions = useWorkspaceActions(scope);
  const workspace = useScopeWorkspace(scope);
  const active = workspace.open && workspace.active === tab.key;
  const subscribe = useCallback(
    (changed: () => void) => subscribeDeviceTab(tabId, changed),
    [tabId],
  );
  const state = useSyncExternalStore(subscribe, () => deviceTabStateOf(tabId));
  const [openFailure, setOpenFailure] = useState<BrowserFailure>();
  const [area, setArea] = useState<HTMLDivElement | null>(null);

  // Open (or take back, after this page reloaded) the tab's view, once per tab. The view is
  // placed only once main has it.
  const opened = useRef(false);
  const [ready, setReady] = useState(false);
  const machine = data?.machine;
  const startUrl = data?.url;
  useTunnelPath(machine);
  useEffect(() => {
    if (!tabs || !machine || !startUrl || opened.current) return;
    opened.current = true;
    tabs.open({ tabId, machineId: machine, url: startUrl }).then(
      () => setReady(true),
      (error: unknown) =>
        setOpenFailure({
          title: "Couldn't open the page",
          detail: error instanceof Error ? error.message : String(error),
        }),
    );
  }, [tabs, tabId, machine, startUrl]);

  // Cmd/Ctrl+L in the page moves typing to the address, as on the thread's own tabs.
  const root = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      tabs?.onFocusAddress((id) => {
        if (id === tabId)
          root.current?.querySelector<HTMLInputElement>('input[aria-label="Address"]')?.focus();
      }),
    [tabs, tabId],
  );

  // The strip's title and the tab's saved address follow the page.
  const remember = useEffectEvent((url: string, title: string) => {
    if (!data || (url === data.url && title === (data.title ?? ""))) return;
    if (!/^https?:\/\//i.test(url)) return;
    actions.update(tab.key, { data: { ...data, url, ...(title ? { title } : {}) } });
  });
  useEffect(() => {
    if (state?.url) remember(state.url, state.title);
  }, [state?.url, state?.title]);

  // A link that asks for a new tab opens another device tab beside this one.
  const openTab = useEffectEvent((url: string) => {
    if (machine) actions.open(deviceTabRequest(machine, url, crypto.randomUUID()));
  });
  useEffect(
    () => tabs?.onOpenTab((request) => request.from === tabId && openTab(request.url)),
    [tabs, tabId],
  );

  const failure = openFailure ?? (state?.failure && deviceTabProblem(state.failure));
  useDevicePlacement(tabId, area, active && ready && !!tabs && !failure && !!data);
  const go = (action: "back" | "forward" | "reload" | "stop") => void tabs?.go({ tabId, action });
  const navigate = (url: string) => {
    setOpenFailure(undefined);
    void tabs?.go({ tabId, action: "navigate", url });
  };
  const url = state?.url || data?.url;
  const loading = state?.loading ?? false;

  return (
    <div ref={root} data-browser-tab="" className="relative flex h-full min-h-0 flex-col">
      <PageToolbar
        nav={
          <PageNav
            back={{ onClick: () => go("back"), disabled: !state?.canGoBack }}
            forward={{ onClick: () => go("forward"), disabled: !state?.canGoForward }}
            reload={{ onClick: () => go("reload"), disabled: !tabs }}
            stop={{ onClick: () => go("stop") }}
            loading={loading}
          />
        }
        address={
          <AddressBar
            url={url}
            loading={loading}
            disabled={tabs ? undefined : "Opens in the desktop app"}
            placeholder="Search or enter a URL"
            onGo={navigate}
          />
        }
        progress={loading ? `Loading ${displayAddress(url ?? "")}` : undefined}
      />
      <div ref={setArea} data-browser-page="" className="relative min-h-0 flex-1">
        {!tabs ? (
          <p role="status" className="px-6 pt-14 text-ui text-muted-foreground">
            This page runs in the desktop app.
          </p>
        ) : failure ? (
          <Problem
            failure={failure}
            url={state?.failure?.url ?? url}
            onReload={() => go("reload")}
          />
        ) : null}
      </div>
    </div>
  );
}

function Problem(props: { failure: BrowserFailure; url: string | undefined; onReload(): void }) {
  return (
    <div
      role="alert"
      className="mx-auto flex w-full max-w-[520px] flex-col items-start px-8 pt-20 pb-10"
    >
      <h2 className="text-md font-medium text-foreground">{props.failure.title}</h2>
      {props.url && (
        <p className="mt-1 text-ui text-muted-foreground">{addressHost(props.url) ?? props.url}</p>
      )}
      <p className="mt-3 text-ui leading-normal text-muted-foreground">{props.failure.detail}</p>
      <div className="mt-6">
        <Button size="sm" onClick={props.onReload}>
          Reload
        </Button>
      </div>
    </div>
  );
}
