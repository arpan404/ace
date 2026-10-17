import type { BrowserBackendSession, BrowserBackend } from "./backend.ts";
import type {
  BrowserAnnotationEvent,
  BrowserArtifact,
  BrowserState,
  ThreadId,
} from "@ace/protocol";
import type { ProcessSpawner } from "./io.ts";
import type { NavigationClock } from "./navigation.ts";
/** Who submits a command. `agentId` gives an agent its own current tab; omitted agents share one. */
export type Actor = { kind: "agent"; agentId?: string } | { kind: "human"; connectionId: string };
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
  /** Persist private ownership before takeover, and retain it through disconnect. */
  privatePaused?: () => void;
  privateResumed?: () => void;
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
  cleanup: () => Promise<void>;
  /** Tab records from before a restart: their labels and openers come back with them. */
  restoredTabs?: readonly import("./tab-store.ts").BrowserTabRecord[];
  /** Keep the thread's tabs whenever they change, for restore after a daemon restart. */
  persistTabs?: (records: import("./tab-store.ts").BrowserTabRecord[]) => void;
  /** A person or agent closed the browser: nothing comes back after a restart. */
  forgetTabs?: () => void;
  /** Freeze idle tabs; omitted, tabs stay live. */
  lifecycle?: import("./session-lifecycle.ts").LifecycleSchedule;
}
