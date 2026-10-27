/* The options a fake daemon starts with, and the shape of a thread it is seeded with. */
import type { AccessMode, Capabilities, ProviderKind, Thread } from "@ace/protocol";
import type { FakeServices } from "./services/index.ts";

export interface FakeDaemonOptions {
  /** Injected clock for event timestamps and core facts. */
  clock(): number;
  /** Keep creation visible for screenshot capture. */
  worktreeCreationSlow?: boolean;
  worktreeCreationSchedule?: (callback: () => void, delay: number) => () => void;
  screenId?(): string;
  screenSchedule?(callback: () => void, delay: number): () => void;
  hostId?: string;
  displayName?: string;
  version?: string;
  /** The OS host.identity reports; absent, as an older daemon's. */
  platform?: import("@ace/protocol").HostPlatform;
  catalog?: Partial<Pick<FakeServices, "accounts" | "models" | "commands" | "providerStatuses">>;
  deviceScopes?: Readonly<Record<string, readonly import("@ace/protocol").DeviceScope[]>>;
  /** Optional finite response for newly created demo threads; tests can step it directly. */
  threadCompletionSchedule?: (callback: () => void) => void;
  projectScheduler?: (callback: () => void) => void;
  /** Credential the hello must present. */
  token?: string;
  /** Snapshot item window (ADR 0006 default is 200). */
  snapshotItems?: number;
}
export interface ThreadInit {
  imported?: Thread["imported"];
  id: string;
  workspaceId: string;
  title: string;
  provider: ProviderKind;
  backend?: Thread["backend"];
  continuation?: Thread["continuation"];
  details?: Thread["details"];
  live?: Thread["live"];
  lineage?: Thread["lineage"];
  execution?: Thread["execution"];
  access?: AccessMode;
  parentThreadId?: string;
  /** A delegated child still waiting for one of its parent's run slots, with its task. */
  queuedLaunch?: Thread["queuedLaunch"];
  /** A conversation an agent started is a task from its start, as the daemon records it. */
  hasSentMessage?: boolean;
  /** What the thread's provider can do, over the fake's defaults (a provider that reads no images). */
  capabilities?: Partial<Capabilities>;
  /**
   * How long an agent with an open turn may stay silent before core reads it as not responding.
   * Scripts send no liveness ticks, so by default silence never counts.
   */
  silenceMs?: number;
}
