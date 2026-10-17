/**
 * The slice of the extension APIs ace for Chrome uses, typed here instead of pulling in the full
 * `chrome` typings. Every promise-returning call is the MV3 promise form.
 */
export interface ChromeEvent<Listener> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}
export interface ChromeTab {
  id?: number;
  windowId: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  active: boolean;
  groupId?: number;
}
export interface ChromeWindow {
  id?: number;
  tabs?: ChromeTab[];
}
export interface DebuggeeSource {
  tabId?: number;
  sessionId?: string;
}
export interface ChromePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: ChromeEvent<(message: unknown) => void>;
  onDisconnect: ChromeEvent<() => void>;
}
export interface ChromeTabs {
  get(tabId: number): Promise<ChromeTab>;
  query(query: { active?: boolean; currentWindow?: boolean }): Promise<ChromeTab[]>;
  create(options: { url?: string; windowId?: number; active?: boolean }): Promise<ChromeTab>;
  remove(tabId: number): Promise<void>;
  update(tabId: number, options: { active?: boolean }): Promise<ChromeTab | undefined>;
  group(options: {
    tabIds: number[];
    groupId?: number;
    createProperties?: { windowId: number };
  }): Promise<number>;
  onRemoved: ChromeEvent<(tabId: number) => void>;
  onUpdated: ChromeEvent<
    (
      tabId: number,
      change: { url?: string; title?: string; groupId?: number; status?: string },
      tab: ChromeTab,
    ) => void
  >;
}
export interface ChromeApi {
  runtime: {
    connectNative(application: string): ChromePort;
    getManifest(): { version: string };
    onMessage: ChromeEvent<
      (message: unknown, sender: unknown, respond: (response: unknown) => void) => boolean | void
    >;
    sendMessage(message: unknown): Promise<unknown>;
  };
  tabs: ChromeTabs;
  tabGroups?: {
    update(groupId: number, options: { title?: string; color?: string }): Promise<unknown>;
  };
  windows: {
    create(options: { focused?: boolean; url?: string }): Promise<ChromeWindow | undefined>;
    get(windowId: number): Promise<ChromeWindow>;
  };
  debugger: {
    attach(target: { tabId: number }, version: string): Promise<void>;
    detach(target: { tabId: number }): Promise<void>;
    sendCommand(target: { tabId: number }, method: string, params?: object): Promise<unknown>;
    onEvent: ChromeEvent<(source: DebuggeeSource, method: string, params?: unknown) => void>;
    onDetach: ChromeEvent<(source: DebuggeeSource, reason: string) => void>;
  };
  action: {
    setBadgeText(details: { text: string }): Promise<void>;
    setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
}
