import type {
  BrowserOpen,
  BrowserArtifact,
  BrowserBackendLost,
  BrowserDownloadProgress,
} from "@ace/protocol";
import type { BrowserBackend } from "./backend.ts";
import type { ChromiumAcquisitionOptions } from "./acquisition.ts";
import type { OriginPolicy } from "./policy.ts";
import type { ContextLauncher, ProcessSpawner } from "./io.ts";

export interface BrowserServiceOptions {
  dataDir: string;
  executablePath?: string;
  ffmpeg?: string;
  originPolicy?: OriginPolicy;
  isPrivatePaused?: (threadId: string) => boolean;
  /** Called before granting a private lease, as well as on its disconnect. */
  onPrivatePaused?: (threadId: string) => void;
  onPrivateResumed?: (threadId: string) => void;
  onNavigation?: (threadId: string) => void;
  origins?: {
    list(threadId: string): import("@ace/protocol").BrowserOriginGrant[];
    grant(threadId: string, origin: string): void;
    revoke(threadId: string, origin: string): void;
  };
  evaluatePolicy?: (
    threadId: string,
    url: string,
    signal?: AbortSignal,
    mode?: "read-only" | "unrestricted",
    expression?: string,
  ) => boolean | Promise<boolean>;
  evaluateGrants?: {
    list(threadId: string): import("@ace/protocol").BrowserEvaluateGrant[];
    revoke(threadId: string, origin: string): void;
  };
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
  maxTabs?: number;
  maxDownloadBytes?: number;
  onArtifact?: (threadId: string, artifact: BrowserArtifact) => void | Promise<void>;
  onError?: (error: unknown) => void;
  now?: () => number;
  navigationClock?: import("./navigation.ts").NavigationClock;
  id?: () => string;
  maxSessions?: number;
  launchContext?: ContextLauncher;
  cleanup?: Partial<import("./chromium-close.ts").ChromiumCleanupRuntime>;
  spawn?: ProcessSpawner;
  headlessBackend?: BrowserBackend;
  backendPreference?: (
    options: BrowserOpen,
  ) => "auto" | "embedded" | "headless" | Promise<"auto" | "embedded" | "headless">;
  backendLoss?: (options: BrowserOpen) => "pause" | "headless" | Promise<"pause" | "headless">;
  acquisition?: Omit<ChromiumAcquisitionOptions, "dataDir" | "signal" | "progress">;
  onDownload?: (progress: BrowserDownloadProgress) => void;
  onBackendLost?: (event: BrowserBackendLost) => void;
}
