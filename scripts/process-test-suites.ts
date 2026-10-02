/** Audited child processes, workers, listening sockets and bulk SQLite integration. */
export const processTestSuites = [
  "apps/daemon/src/{auth.server,client-limits,device-creation.server,delivery-runtime,input-capacity,items-window,lifecycle,mcp,notification-race,notification-shutdown,notifications.remote,notifications.server,ownership.server,outbox-work,payloads,presence-pressure,pressure,remote-boundaries.server,remote-cli,remote-payloads,remote.server,server,subscription,text-storage,ticket-allocation.server}.test.ts",
  "apps/relay/src/{abuse,availability,relay,throttling,validation}.test.ts",
  "packages/provider-kit/src/{process,jsonrpc,sse,sse-recovery,live}.test.ts",
  "packages/provider-kit/src/discovery/discovery.test.ts",
  "packages/mcp-server/src/{admission,discovery-apis,discovery-fifo,http,http-boundaries,lifetime}.test.ts",
  "packages/notify/src/{apns,ipc,webpush,worker,review}.test.ts",
  "packages/git/src/**/*.test.ts",
  "packages/orchestrator/src/git{,-boundary}.test.ts",
  "tools/recorder/src/stdio.test.ts",
  "packages/adapter-testkit/src/cli.test.ts",
  // Main advanced during this audit; these match after the model catalog merges.
  "apps/daemon/src/models.server.test.ts",
  "packages/models/src/{catalog,discover,review,storage,streaming}.test.ts",
];
