// TODO(client-gaps): feat/client-protocol-gaps adds the client messages. The daemon's terminal (`@ace/terminal`),
// browser (`@ace/browser`) and preview (`@ace/preview`) services have no client wire messages
// on main yet. These interfaces follow their shapes (`TerminalEvent`, `BrowserState`,
// `BrowserFrame`, `BrowserInput`, `PreviewDescriptor`), so wiring them is a change to this
// file and `services.ts` only.

export type TerminalEvent =
  | { type: "data"; offset: number; endOffset: number; data: string; truncatedBefore: boolean }
  | { type: "resync"; oldestOffset: number; nextOffset: number }
  | { type: "exit"; code: number; nextOffset: number };
export interface TerminalInfo {
  id: string;
  threadId: string;
  name: string;
  cwd: string;
  cols: number;
  rows: number;
  exitCode: number | null;
}
export interface OpenTerminal {
  threadId: string;
  cwd: string;
  cols: number;
  rows: number;
  name?: string;
}

/** PTYs owned by the daemon. Output survives client disconnects; attach replays from an offset. */
export interface TerminalSource {
  readonly available: boolean;
  readonly link: "connected" | "disconnected";
  /** Changes whenever `list` or `link` would. */
  readonly version: number;
  subscribe(listener: () => void): () => void;
  list(threadId: string): readonly TerminalInfo[];
  open(request: OpenTerminal): Promise<TerminalInfo>;
  attach(id: string, fromOffset: number, listener: (event: TerminalEvent) => void): () => void;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  close(id: string): void;
}

export interface BrowserView {
  threadId: string;
  controller: "agent" | "human" | "none";
  owner?: string;
  url: string;
  closed: boolean;
}
export interface ScreenFrame {
  sequence: number;
  src: string;
  width: number;
  height: number;
}
export interface PreviewServer {
  port: number;
  origin?: string;
  name?: string;
  source: "listener" | "terminal" | "launch";
}
export type ForwardedInput =
  | { kind: "mouse"; event: "mousePressed" | "mouseReleased"; x: number; y: number }
  | { kind: "key"; event: "keyDown"; key: string; text?: string };

/** The agent-driven browser (live view, take-over) and detected dev servers of a thread. */
export interface PreviewSource {
  readonly available: boolean;
  readonly version: number;
  subscribe(listener: () => void): () => void;
  view(threadId: string): BrowserView | undefined;
  frame(threadId: string): ScreenFrame | undefined;
  servers(threadId: string): readonly PreviewServer[];
  takeover(threadId: string): Promise<void>;
  handback(threadId: string): Promise<void>;
  input(threadId: string, input: ForwardedInput): void;
  /**
   * Size the page's viewport to the pane, in CSS pixels (BrowserCommand `resize`, 100–4096).
   * Absent when the backend can't resize; the view then scales the frame to fit.
   */
  resize?: ((threadId: string, width: number, height: number) => void) | undefined;
}

const none: readonly never[] = [];
const offline = () => Promise.reject(new Error("unavailable"));

/** What a real daemon offers until the services above are on the wire. */
export const unavailableTerminals: TerminalSource = {
  available: false,
  link: "disconnected",
  version: 0,
  subscribe: () => () => {},
  list: () => none,
  open: offline,
  attach: () => () => {},
  write: () => {},
  resize: () => {},
  close: () => {},
};
export const unavailablePreview: PreviewSource = {
  available: false,
  version: 0,
  subscribe: () => () => {},
  view: () => undefined,
  frame: () => undefined,
  servers: () => none,
  takeover: offline,
  handback: offline,
  input: () => {},
};
