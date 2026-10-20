import type {
  BrowserOpen,
  BrowserArtifact,
  BrowserBackendLost,
  BrowserDownloadProgress,
  BrowserProfileScope,
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
  /**
   * Use my Chrome: whether the person lets agents' `evaluate` read the page's cookies and web
   * storage (`browser.userChrome.storageReads`). Omitted: never.
   */
  userChromeStorageReads?: (threadId: string) => boolean | Promise<boolean>;
  /**
   * Draw agents' cursors in pages, in every engine (ADR 0082, agent cursor); omitted, none are
   * drawn. Agent screenshots and recordings mask secret fields either way.
   */
  agentCursor?: {
    /** How long a cursor glides before the agent's input lands; default 220 ms. */
    glideMs?: number;
    /** The agent's name for its cursor's label. */
    name?(threadId: string, agentId: string | undefined): string | undefined;
  };
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
  /**
   * The daemon-wide tab budget, shared with another service (Use my Chrome's tabs count
   * against the same 48 as ace's own). Omitted: a budget of `maxTabs` for this service.
   */
  tabBudget?: import("./tab-budget.ts").TabBudget;
  /**
   * The thread a thread was forked from, if any. A fork opening its browser for the first time
   * starts with a copy of that thread's tabs (addresses and labels, new tab ids).
   */
  forkedFrom?: (threadId: string) => string | undefined;
  /** Where thread tabs are kept for restore after a daemon restart; omitted, nowhere. */
  tabStore?: import("./tab-store.ts").BrowserTabStore;
  /**
   * How the service notices the computer woke from sleep on its own (wall time running ahead of
   * monotonic time); `false` turns it off. Default: every 10 s, a 30 s tolerance.
   */
  wakeWatch?: import("./wake-watch.ts").WakeWatch | false;
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
  /** How long the encoder-only Chrome (`BrowserService.videoEncoder`) outlives its last capture. Default 30 s. */
  videoEncoderIdleMs?: number;
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
   * How long a backend that has another one behind it (the desktop, under `auto`) may take to
   * draw a new session's first picture before the next backend takes the session. A desktop
   * that can't draw (its screen locked or asleep) never answers. Default 10 s.
   */
  firstPictureMs?: number;
  /**
   * The profile for an open that names none; the library default is `persistent`, the kept
   * profile `profileScope` picks. `ephemeral` is a private throwaway context inside it.
   */
  profilePreference?: (
    options: BrowserOpen,
  ) => "persistent" | "ephemeral" | Promise<"persistent" | "ephemeral">;
  /**
   * Which kept profile a thread's browser opens in (`browser.profileScope`, a project's choice
   * first). Read when a browser opens; the library default is `global`, one shared profile.
   */
  profileScope?: (options: BrowserOpen) => BrowserProfileScope | Promise<BrowserProfileScope>;
  /**
   * Where ace's own Chrome saves what a thread downloads (the daemon's `browser.downloadDir`):
   * an existing, writable folder on this machine. Undefined keeps downloads with the thread's
   * browser session. Read for each download, so a change applies to the next one.
   */
  downloadFolder?: (options: BrowserOpen) => Promise<string | undefined>;
  /** A desktop backend registered; called after the registration reply is on its way. */
  onEmbeddedRegistered?: () => void;
  acquisition?: Omit<ChromiumAcquisitionOptions, "dataDir" | "signal" | "progress">;
  onDownload?: (progress: BrowserDownloadProgress) => void;
  onBackendLost?: (event: BrowserBackendLost) => void;
}
