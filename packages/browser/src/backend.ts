import type { BrowserOpen, BrowserControllerLease } from "@ace/protocol";

/** Opaque CDP results are parsed by their owning operation before use. */
export interface BrowserCdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(method: string, listener: (params: unknown) => void): unknown;
  off(method: string, listener: (params: unknown) => void): unknown;
}
export interface BackendLog {
  kind: "console" | "network";
  type: string;
  text: string;
}
export interface BackendOpen {
  options: BrowserOpen;
  profileDir: string;
  signal: AbortSignal;
  allowed(url: string, context?: { navigation?: boolean }): Promise<boolean>;
  navigation(): void;
  log(entry: BackendLog): void;
  lost(reason: string): void;
  /** Version 1 backends deny natively before reporting these hooks. */
  permissionDenied?(request: { origin: string; permission: string }): void;
  downloadDenied?(request: { url: string; suggestedFilename: string }): void;
}
export interface BrowserBackendSession {
  readonly cdp: BrowserCdp;
  url(): string;
  navigate(url: string, timeout: number): Promise<void>;
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
