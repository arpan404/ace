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
  evaluatePolicy?: (
    threadId: string,
    url: string,
    signal?: AbortSignal,
  ) => boolean | Promise<boolean>;
  onArtifact?: (threadId: string, artifact: BrowserArtifact) => void | Promise<void>;
  onError?: (error: unknown) => void;
  now?: () => number;
  id?: () => string;
  maxSessions?: number;
  launchContext?: ContextLauncher;
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
