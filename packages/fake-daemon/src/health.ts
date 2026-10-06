import type { DiagnosticsHealth } from "@ace/protocol";

/** Plausible, deterministic health numbers for request/response screens. */
export function fakeHealth(at: number, threads: number): DiagnosticsHealth {
  return {
    at,
    eventLoop: { meanMs: 0.4, p99Ms: 2.1, maxMs: 6.8 },
    memory: {
      rssBytes: 96 * 1024 * 1024,
      heapUsedBytes: 41 * 1024 * 1024,
      heapTotalBytes: 64 * 1024 * 1024,
    },
    openHandles: 12,
    sqlite: { pageBytes: 4096, walBytes: 128 * 1024 },
    activeSessions: threads,
    queues: { intents: 0, notifications: 0, "output.chunks": 3 },
    logs: { dropped: 0, failed: 0, queued: 0, directory: "/Users/dev/.ace-next/logs" },
  };
}
