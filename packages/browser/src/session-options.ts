import type { BrowserBackendSession, BrowserBackend } from "./backend.ts";
import type { BrowserArtifact, BrowserState, ThreadId } from "@ace/protocol";
import type { ProcessSpawner } from "./io.ts";
import type { NavigationClock } from "./navigation.ts";
export type Actor = { kind: "agent" } | { kind: "human"; connectionId: string };
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
  privatePaused?: () => void;
  privateResumed?: () => void;
  navigatePolicy: (url: string, actor: Actor, signal?: AbortSignal) => Promise<boolean>;
  evaluatePolicy?: (
    threadId: string,
    url: string,
    mode?: "read-only" | "unrestricted",
    expression?: string,
  ) => boolean | Promise<boolean>;
  artifactAllowed?: (path: string) => boolean | Promise<boolean>;
  workspaceRoot?: () => string | Promise<string>;
  uploadPolicy?: (paths: string[], signal?: AbortSignal) => boolean | Promise<boolean>;
  artifact: (artifact: BrowserArtifact) => void | Promise<void>;
  state: (state: BrowserState) => void;
  cleanup: () => Promise<void>;
}
