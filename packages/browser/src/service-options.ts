import type {
  BrowserOpen,
  BrowserArtifact,
  BrowserBackendLost,
  BrowserDownloadProgress,
} from "@ace/protocol";
import type { BrowserBackend } from "./backend.ts";
import type { ChromiumAcquisitionOptions } from "./acquisition.ts";
import type { OriginPolicy } from "./policy.ts";
import type { ProcessSpawner } from "./io.ts";
import type { ChromeCleanup, ChromeLaunch } from "./chrome-instance.ts";

export interface BrowserServiceOptions {
  dataDir: string;
  executablePath?: string;
  ffmpeg?: string;
  originPolicy?: OriginPolicy;
  /** How people and agents share tabs; omitted, `collaborationTiming`. */
  collaboration?: import("./collaboration.ts").CollaborationTiming;
  evaluatePolicy?: (
    threadId: string,
    url: string,
    signal?: AbortSignal,
    mode?: "read-only" | "unrestricted",
    expression?: string,
  ) => boolean | Promise<boolean>;
  downloadPolicy?: (
    threadId: string,
    url: string,
    signal?: AbortSignal,
  ) => boolean | Promise<boolean>;
  uploadPolicy?: (
    threadId: string,
    paths: string[],
    signal?: AbortSignal,
  ) => boolean | Promise<boolean>;
  artifactAllowed?: (threadId: string, path: string) => boolean | Promise<boolean>;
  workspaceRoot?: (threadId: string) => string | Promise<string>;
  /** Live tabs across every thread; default 48 (ADR 0083). */
  maxTabs?: number;
  /** Where thread tabs are kept for restore after a daemon restart; omitted, nowhere. */
  tabStore?: import("./tab-store.ts").BrowserTabStore;
  /** Idle-tab freezing in ace's Chrome; `false` turns it off. */
  tabLifecycle?: import("./session-lifecycle.ts").LifecycleSchedule | false;
  maxDownloadBytes?: number;
  onArtifact?: (threadId: string, artifact: BrowserArtifact) => void | Promise<void>;
  onError?: (error: unknown) => void;
  now?: () => number;
  navigationClock?: import("./navigation.ts").NavigationClock;
  id?: () => string;
  maxSessions?: number;
  /** ace's own Chrome: launch flags, device scale, idle exit and the process edge. */
  chrome?: Partial<ChromeLaunch>;
  /** Browser shutdown deadline and its force-kill. */
  cleanup?: Partial<ChromeCleanup>;
  /** The recording encoder's process edge. */
  spawn?: ProcessSpawner;
  headlessBackend?: BrowserBackend;
  backendPreference?: (
    options: BrowserOpen,
  ) => "auto" | "embedded" | "headless" | Promise<"auto" | "embedded" | "headless">;
  backendLoss?: (options: BrowserOpen) => "pause" | "headless" | Promise<"pause" | "headless">;
  /**
   * How long a thread whose desktop link dropped waits for the desktop to re-adopt its views
   * before reporting their pages lost (ADR 0085); 0 reports at once. Default 10 s.
   */
  desktopReadoptionGraceMs?: number;
  /**
   * The profile for an open that names none; the library default is `persistent`, ace's one
   * shared browser profile. `ephemeral` is a private throwaway context inside it.
   */
  profilePreference?: (
    options: BrowserOpen,
  ) => "persistent" | "ephemeral" | Promise<"persistent" | "ephemeral">;
  /** A desktop backend registered; called after the registration reply is on its way. */
  onEmbeddedRegistered?: () => void;
  acquisition?: Omit<ChromiumAcquisitionOptions, "dataDir" | "signal" | "progress">;
  onDownload?: (progress: BrowserDownloadProgress) => void;
  onBackendLost?: (event: BrowserBackendLost) => void;
}
