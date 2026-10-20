export { BrowserService, type BrowserServiceOptions } from "./service.ts";
export { detectChromium, installChromium } from "./discovery.ts";
export { connectBrowser } from "./bridge.ts";
export type { ViewerSink } from "./viewer-sink.ts";
export { screencastSettings } from "./capture-policy.ts";
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

export {
  browserToolkit,
  browserChoiceInput,
  browserMachineInput,
  type BrowserCaller,
  type BrowserMachineRoute,
  type BrowserTabRef,
  type BrowserToolPort,
} from "./mcp.ts";
export { agentBrowserError } from "./agent-errors.ts";
export type { AgentScreenshot } from "./session-images.ts";
export type { ScreenshotGeometry } from "./screenshot-geometry.ts";

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
  CaptureEvents,
  EncodedAudio,
  EncodedChunk,
  VideoHost,
} from "./backend.ts";
export type { BrowserTabRecord, BrowserTabStore } from "./tab-store.ts";
export { agentTabLimit, daemonTabLimit, threadTabLimit } from "./tab-limits.ts";
export { TabBudget } from "./tab-budget.ts";
export type { LifecycleSchedule } from "./session-lifecycle.ts";
export { acquireChromium, type ChromiumAcquisitionOptions } from "./acquisition.ts";
export { chromiumArtifact, ChromiumArtifact } from "./chromium-manifest.ts";

export { chromiumProcessKiller, type KillCommand } from "./chromium-process.ts";
export { UserChromeHub, userChromeLinkLimit } from "./user-chrome-hub.ts";
export { UserChromeBackend, type UserTabRef } from "./user-chrome.ts";
export { UserChromeTabsBackend } from "./user-chrome-tabs.ts";
export type { UserChromeLink, UserChromeTransport } from "./user-chrome-link.ts";
/** One snapshot line as agents read it, for excerpts built outside the tools. */
export { snapshotLine } from "./snapshot-text.ts";
export type { CompactNode } from "./snapshot-compact.ts";
