export { BrowserService, type BrowserServiceOptions } from "./service.ts";
export { detectChromium, installChromium } from "./discovery.ts";
export { connectBrowser } from "./bridge.ts";
export { FrameFanout, captureSettings, type FrameSink } from "./fanout.ts";
export { SessionLogs } from "./logs.ts";
export {
  BrowserOriginError,
  browserOrigin,
  allowedOrigin,
  type OriginPolicy,
  type OriginRequest,
} from "./policy.ts";
export type { Actor } from "./session.ts";
export type { NavigationClock } from "./navigation.ts";

export type { ProcessSpawner } from "./io.ts";

export { browserToolkit, browserMachineInput, type BrowserMachineRoute } from "./mcp.ts";

export { Recording as BrowserRecording } from "./recording.ts";
export { ChromeBackend, type ChromeBackendOptions } from "./headless.ts";
export type { ChromeCleanup, ChromeLaunch } from "./chrome-instance.ts";
export type { CdpIntercept, CdpSend } from "./cdp-connection.ts";
export { EmbeddedBackend, type EmbeddedTransport } from "./embedded.ts";
export type {
  BrowserBackend,
  BrowserBackendPage,
  BrowserBackendSession,
  BrowserBackendTabs,
  BrowserCdp,
  BackendOpen,
} from "./backend.ts";
export type { BrowserTabRecord, BrowserTabStore } from "./tab-store.ts";
export { agentTabLimit, daemonTabLimit, threadTabLimit } from "./tab-limits.ts";
export type { LifecycleSchedule } from "./session-lifecycle.ts";
export { acquireChromium, type ChromiumAcquisitionOptions } from "./acquisition.ts";
export { chromiumArtifact, ChromiumArtifact } from "./chromium-manifest.ts";

export { chromiumProcessKiller, type KillCommand } from "./chromium-process.ts";
