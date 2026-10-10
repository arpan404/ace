import { afterEach, expect, test } from "vitest";
import { CredentialRegistry, ToolRegistry, startMcpServer } from "./index.ts";
import { scope } from "./test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).toReversed()) await stop();
});

async function fixture() {
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  const lease = credentials.issue(scope(), new AbortController().signal);
  const server = await startMcpServer({
    credentials,
    registry: new ToolRegistry({ scheduler: { after: () => () => {} } }),
  });
  cleanup.push(server.close);
  const headers = {
    Authorization: `Bearer ${lease.bearer}`,
    "X-Ace-Notifications": "stream",
    "MCP-Protocol-Version": "2025-11-25",
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const initialize = async () => {
    const response = await fetch(server.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    });
    await response.arrayBuffer();
    expect(response.status).toBe(200);
    const id = response.headers.get("mcp-session-id");
    if (!id) throw new Error("No negotiated session");
    return id;
  };
  return { server, headers, initialize };
}

test("reinitializing a legacy client past 128 times keeps new sessions usable and releases superseded sessions", async () => {
  const f = await fixture();
  const first = await f.initialize();
  let latest = first;
  for (let index = 0; index < 129; index++) latest = await f.initialize();
  const old = await fetch(f.server.url, {
    method: "DELETE",
    headers: { ...f.headers, "Mcp-Session-Id": first },
  });
  expect(old.status).toBe(404);
  await old.arrayBuffer();
  const current = await fetch(f.server.url, {
    method: "DELETE",
    headers: { ...f.headers, "Mcp-Session-Id": latest },
  });
  expect(current.status).toBe(200);
  await current.arrayBuffer();
});

test("a dropped legacy notification stream releases its session without waiting for lease expiry", async () => {
  const f = await fixture();
  const id = await f.initialize();
  const pendingStream = fetch(f.server.url, { headers: { ...f.headers, "Mcp-Session-Id": id } });
  const barrier = await fetch(f.server.url, {
    method: "POST",
    headers: { ...f.headers, "Mcp-Session-Id": id },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  await barrier.arrayBuffer();
  f.server.toolsChanged();
  const stream = await pendingStream;
  expect(stream.status).toBe(200);
  await stream.body?.cancel();
  // The HTTP disconnect crosses the node/web-stream boundary asynchronously.
  // An awaited request provides the I/O barrier, with no timer-based polling.
  let released = false;
  for (let attempt = 0; attempt < 32; attempt++) {
    const probe = await fetch(f.server.url, {
      method: "POST",
      headers: { ...f.headers, "Mcp-Session-Id": id },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    await probe.arrayBuffer();
    if (probe.status === 404) {
      released = true;
      break;
    }
  }
  expect(released).toBe(true);
  await f.initialize();
});
