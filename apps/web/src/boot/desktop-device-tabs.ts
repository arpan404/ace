import type { PageBox } from "./desktop-browser.ts";

/*
 * The desktop app's device tabs (`window.ace.deviceTabs`, ADR 0194): pages the person opens on a
 * remote machine's thread, each a native view on this computer in that machine's partition,
 * reaching the machine's localhost through its tunnel. A browser has no bridge: undefined.
 */

/** Why the machine's localhost didn't answer, as the desktop's proxy recorded it. */
export type DeviceTabTunnelFailure =
  | "off"
  | "forbidden"
  | "refused"
  | "limit"
  | "offline"
  | "closed"
  | "failed";

export interface DeviceTabFailure {
  url: string;
  code: number;
  /** Chromium's error name (`ERR_CONNECTION_REFUSED`). */
  description: string;
  tunnel?: DeviceTabTunnelFailure | undefined;
  port?: number | undefined;
}

export interface DeviceTabState {
  tabId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  failure?: DeviceTabFailure | undefined;
}

/** What the desktop's main process needs to open a machine's tunnel on one path. */
export interface TunnelPathRequest {
  key: string;
  target:
    | { kind: "direct"; url: string; fingerprint: string }
    | { kind: "relay"; url: string; hostKey: string };
  /** The daemon every welcome must name. */
  expectedHostId: string;
  deviceId: string;
  token: string;
}

export interface DesktopDeviceTabs {
  open(request: { tabId: string; machineId: string; url: string }): Promise<void>;
  place(request: {
    tabId: string;
    bounds: PageBox;
    visible: boolean;
  }): Promise<"shown" | "hidden" | "unavailable">;
  go(
    request:
      | { tabId: string; action: "navigate"; url: string }
      | { tabId: string; action: "back" | "forward" | "reload" | "stop" },
  ): Promise<boolean>;
  close(tabId: string): Promise<void>;
  /**
   * The path a remote machine's connection is on, for its tunnel in the main process, which
   * holds it as this window's lease on the machine; null ends the lease.
   */
  tunnelPath(request: { machineId: string; path: TunnelPathRequest | null }): Promise<void>;
  onState(listener: (state: DeviceTabState) => void): () => void;
  onOpenTab(listener: (request: { from: string; url: string }) => void): () => void;
  /** `CmdOrCtrl+L` was pressed in a device tab's page. */
  onFocusAddress(listener: (tabId: string) => void): () => void;
}

const failures = new Set<string>([
  "off",
  "forbidden",
  "refused",
  "limit",
  "offline",
  "closed",
  "failed",
]);
const isTunnelFailure = (value: unknown): value is DeviceTabTunnelFailure =>
  typeof value === "string" && failures.has(value);
const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** A `deviceTab.state` event, field by field; undefined when it isn't one. */
export function deviceTabState(event: unknown): DeviceTabState | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const get = (key: string): unknown => Reflect.get(event, key);
  const tabId = text(get("tabId"));
  const url = text(get("url"));
  const title = text(get("title"));
  if (!tabId || url === undefined || title === undefined) return undefined;
  const failure = get("failure");
  let parsed: DeviceTabFailure | undefined;
  if (typeof failure === "object" && failure !== null) {
    const failed = (key: string): unknown => Reflect.get(failure, key);
    const code = failed("code");
    const tunnel = failed("tunnel");
    const port = failed("port");
    parsed = {
      url: text(failed("url")) ?? url,
      code: typeof code === "number" ? code : 0,
      description: text(failed("description")) ?? "",
      ...(isTunnelFailure(tunnel) ? { tunnel } : {}),
      ...(typeof port === "number" ? { port } : {}),
    };
  }
  return {
    tabId,
    url,
    title,
    loading: get("loading") === true,
    canGoBack: get("canGoBack") === true,
    canGoForward: get("canGoForward") === true,
    ...(parsed ? { failure: parsed } : {}),
  };
}

const method = (target: object, name: string): ((...args: unknown[]) => unknown) | undefined => {
  const value: unknown = Reflect.get(target, name);
  return typeof value === "function"
    ? (...args: unknown[]) => Reflect.apply(value, target, args)
    : undefined;
};

const unsubscribe = (stop: unknown) => () => {
  if (typeof stop === "function") stop();
};

export function desktopDeviceTabs(scope: object = globalThis): DesktopDeviceTabs | undefined {
  const ace: unknown = Reflect.get(scope, "ace");
  const tabs: unknown =
    typeof ace === "object" && ace !== null ? Reflect.get(ace, "deviceTabs") : undefined;
  if (typeof tabs !== "object" || tabs === null) return undefined;
  const open = method(tabs, "open");
  const place = method(tabs, "place");
  const go = method(tabs, "go");
  const close = method(tabs, "close");
  const onState = method(tabs, "onState");
  const onOpenTab = method(tabs, "onOpenTab");
  const tunnelPath = method(tabs, "tunnelPath");
  const onFocusAddress = method(tabs, "onFocusAddress");
  if (!open || !place || !go || !close || !onState || !onOpenTab || !tunnelPath || !onFocusAddress)
    return undefined;
  return {
    open: async (request) => {
      await open(request);
    },
    place: async (request) => {
      const receipt: unknown = await Promise.resolve(place(request)).catch(() => "unavailable");
      return receipt === "shown" || receipt === "hidden" ? receipt : "unavailable";
    },
    go: async (request) => (await Promise.resolve(go(request)).catch(() => false)) === true,
    tunnelPath: async (request) => {
      await Promise.resolve(tunnelPath(request)).catch(() => {});
    },
    close: async (tabId) => {
      await Promise.resolve(close({ tabId })).catch(() => {});
    },
    onState: (listener) =>
      unsubscribe(
        onState((event: unknown) => {
          const state = deviceTabState(event);
          if (state) listener(state);
        }),
      ),
    onOpenTab: (listener) =>
      unsubscribe(
        onOpenTab((event: unknown) => {
          if (typeof event !== "object" || event === null) return;
          const from = text(Reflect.get(event, "from"));
          const url = text(Reflect.get(event, "url"));
          if (from && url && /^https?:\/\//i.test(url)) listener({ from, url });
        }),
      ),
    onFocusAddress: (listener) =>
      unsubscribe(
        onFocusAddress((event: unknown) => {
          if (typeof event !== "object" || event === null) return;
          const tabId = text(Reflect.get(event, "tabId"));
          if (tabId) listener(tabId);
        }),
      ),
  };
}
