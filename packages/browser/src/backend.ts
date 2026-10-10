import type {
  BrowserOpen,
  BrowserControllerLease,
  BrowserTab,
  BrowserDownload,
  BrowserDialog,
} from "@ace/protocol";

/** Opaque CDP results are parsed by their owning operation before use. */
export interface BrowserCdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(method: string, listener: (params: unknown) => void): unknown;
  off(method: string, listener: (params: unknown) => void): unknown;
}
export interface BackendLog {
  requestId?: string;
  url?: string;
  status?: number;
  kind: "console" | "network";
  type: string;
  text: string;
}
export interface BackendOpen {
  options: BrowserOpen;
  id?(): string;
  reserveTab?(): () => void;
  changed?(): void;
  downloadDir?: string;
  maxDownloadBytes?: number;
  downloadAllowed?(url: string): Promise<boolean>;
  artifact?(artifact: import("@ace/protocol").BrowserArtifact): void | Promise<void>;
  profileDir: string;
  signal: AbortSignal;
  allowed(url: string, context?: { navigation?: boolean; human?: boolean }): Promise<boolean>;
  /** Initiating actor of active work, otherwise the current lease owner. */
  initiator?(): boolean;
  navigation(): void;
  restarted?(): void;
  log(entry: BackendLog): void;
  lost(reason: string): void;
  /** Version 1 backends deny natively before reporting these hooks. */
  permissionDenied?(request: { origin: string; permission: string }): void;
  downloadDenied?(request: { url: string; suggestedFilename: string }): void;
}
export interface BrowserBackendSession {
  readonly cdp: BrowserCdp;
  tabs?: {
    list(): BrowserTab[];
    active(): string;
    open(): Promise<string>;
    switch(tabId: string): Promise<void>;
    close(tabId: string): Promise<void>;
    dialog(): BrowserDialog | undefined;
    answer(dialogId: string, accept: boolean, promptText?: string): Promise<void>;
    downloads(): BrowserDownload[];
  };
  findText?(text: string, forward: boolean): Promise<unknown>;
  privateMode?(enabled: boolean): void;
  pageStatus?(): {
    loading: boolean;
    loadError?: string | undefined;
    permissionDenied?: { origin: string; permission: string } | undefined;
  };
  networkBody?(requestId: string): Promise<unknown>;
  frames?(): Promise<{ frameId: string; cdp: BrowserCdp; parentId?: string }[]>;
  url(): string;
  navigate(url: string, timeout: number, signal?: AbortSignal): Promise<void>;
  click(x: number, y: number): Promise<void>;
  insertText(text: string): Promise<void>;
  press(key: string): Promise<void>;
  wheel(x: number, y: number): Promise<void>;
  screenshot(format: "png" | "jpeg"): Promise<Buffer>;
  resize(width: number, height: number): Promise<void>;
  viewport(): { width: number; height: number };
  media(colorScheme: "light" | "dark" | "no-preference"): Promise<void>;
  /** Must apply the generation before resolving, reject obsolete generations. */
  controller(lease: BrowserControllerLease): Promise<void>;
  close(): Promise<void>;
}
export interface BrowserBackend {
  readonly kind: "embedded" | "headless";
  open(request: BackendOpen): Promise<BrowserBackendSession>;
}
