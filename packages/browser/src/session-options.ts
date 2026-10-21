import type { BrowserBackendSession, BrowserBackend } from "./backend.ts";
import type {
  BrowserAnnotationEvent,
  BrowserArtifact,
  BrowserPageState,
  BrowserState,
  ThreadId,
} from "@ace/protocol";
import type { ProcessSpawner } from "./io.ts";
import type { NavigationClock } from "./navigation.ts";
/** Who submits a command. `agentId` gives an agent its own current tab; omitted agents share one. */
export type Actor = { kind: "agent"; agentId?: string } | { kind: "human"; connectionId: string };
export interface SessionCursor {
  visible: boolean;
  /** How long a cursor glides before the agent's input lands under it. */
  glideMs?: number;
  /** The person's accent, read whenever a layer is drawn or restyled. */
  style(): import("@ace/browser-annotate").CursorStyle;
  name?(agentId: string | undefined): string | undefined;
}
export interface SessionOptions {
  threadId: ThreadId;
  backend: BrowserBackendSession;
  backendKind: BrowserBackend["kind"];
  dir: string;
  now: () => number;
  id: () => string;
  navigationClock: NavigationClock;
  ffmpeg?: string;
  spawn?: ProcessSpawner;
  cancelPolicy: () => void;
  /** How people and agents share tabs; omitted, `collaborationTiming`. */
  collaboration?: import("./collaboration.ts").CollaborationTiming;
  navigatePolicy: (url: string, actor: Actor, signal?: AbortSignal) => Promise<boolean>;
  evaluatePolicy?: (
    threadId: string,
    url: string,
    mode?: "read-only" | "unrestricted",
    expression?: string,
    signal?: AbortSignal,
  ) => boolean | Promise<boolean>;
  artifactAllowed?: (path: string) => boolean | Promise<boolean>;
  workspaceRoot?: () => string | Promise<string>;
  uploadPolicy?: (paths: string[], signal?: AbortSignal) => boolean | Promise<boolean>;
  artifact: (artifact: BrowserArtifact) => void | Promise<void>;
  state: (state: BrowserState) => void;
  /** Annotation events for the one connection that started annotate mode (ADR 0082). */
  annotation?: (connectionId: string, event: BrowserAnnotationEvent) => void;
  /** A tab's page state for remote views changed: its focused field, picker, cursor, tooltip. */
  pageState?: (tabId: string, page: BrowserPageState) => void;
  cleanup: () => Promise<void>;
  /**
   * The browser paused itself: the live capture of the viewed tab failed (a desktop view that
   * stopped drawing never answers its first picture). Its owner recovers the pages from here,
   * as it would after losing the backend; without one the browser stays paused.
   */
  suspended?: (reason: string) => void;
  /** Tab records from before a restart: their labels and openers come back with them. */
  restoredTabs?: readonly import("./tab-store.ts").BrowserTabRecord[];
  /** Keep the thread's tabs whenever they change, for restore after a daemon restart. */
  persistTabs?: (records: import("./tab-store.ts").BrowserTabRecord[]) => void;
  /** A person or agent closed the browser: nothing comes back after a restart. */
  forgetTabs?: () => void;
  /** Use my Chrome: the person lets agents' evaluate read cookies and storage. Omitted: never. */
  storageReads?: () => boolean | Promise<boolean>;
  /** Agents' cursors drawn in the page (ADR 0082); omitted, none (captures still mask secrets). */
  cursor?: SessionCursor;
  /** Freeze idle tabs; omitted, tabs stay live. */
  lifecycle?: import("./session-lifecycle.ts").LifecycleSchedule;
}
