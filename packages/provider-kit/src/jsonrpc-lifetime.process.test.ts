import { afterEach, expect, it } from "vitest";
import { JsonRpcPeer } from "./jsonrpc.ts";
import { spawnSupervised, type SupervisedProcess } from "./process.ts";

const processes: SupervisedProcess[] = [];
const noop = () => {};
afterEach(async () => {
  await Promise.all(processes.splice(0).map((proc) => proc.stop({ graceMs: 0 })));
});
function child(script: string) {
  const proc = spawnSupervised({
    command: process.execPath,
    args: ["-e", script],
    env: {},
    name: "rpc-budget",
  });
  processes.push(proc);
  return proc;
}
const echo = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='echo')console.log(JSON.stringify({id:m.id,result:m.params}));});`;

it.each(["cancel", "timeout"])(
  "late responses cannot claim a reused explicit id after %s",
  async (mode) => {
    const proc = child(
      `let old;require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='old'){old=m.id;console.log(JSON.stringify({method:'seen'}));}else if(m.method==='fresh'){console.log(JSON.stringify({id:old,result:'STALE'}));console.log(JSON.stringify({id:m.id,result:'FRESH'}));}});`,
    );
    let expire: () => void = noop;
    const rpc = new JsonRpcPeer(proc, {
      schedule: (_delayMs, callback) => {
        expire = callback;
        return () => {
          expire = () => {};
        };
      },
    });
    const seen = new Promise<void>((resolve) => {
      rpc.onNotification = () => resolve();
    });
    const controller = new AbortController();
    const pending = rpc
      .request("old", undefined, {
        id: "reused",
        signal: controller.signal,
        timeoutMs: mode === "timeout" ? 500 : null,
      })
      .catch((error: unknown) => String(error));
    try {
      await seen;
      if (mode === "cancel") controller.abort(new Error("cancelled"));
      else expire();
      expect(await pending).toContain(mode === "cancel" ? "cancelled" : "timed out");
      await expect(rpc.request("fresh", undefined, { id: "reused" })).rejects.toThrow(
        "Request id already used",
      );
      expect(await rpc.request("fresh")).toBe("FRESH");
    } finally {
      rpc.close();
    }
  },
);

it("a disposed peer sees no frames while another peer continues on its live owner", async () => {
  const proc = child(echo);
  const frames: unknown[] = [],
    notifications: unknown[] = [];
  const disposed = new JsonRpcPeer(proc, { onFrame: (_direction, frame) => frames.push(frame) });
  disposed.onNotification = (message) => notifications.push(message);
  disposed.close();
  const active = new JsonRpcPeer(proc);
  try {
    expect(await active.request("echo", "alive")).toBe("alive");
    expect(frames).toEqual([]);
    expect(notifications).toEqual([]);
    expect(proc.signal.aborted).toBe(false);
  } finally {
    active.close();
  }
});

it("generated ids skip explicit ids and neither can be reused after settlement", async () => {
  const rpc = new JsonRpcPeer(child(echo), { maxExplicitIds: 2 });
  try {
    expect(await rpc.request("echo", "explicit", { id: 1 })).toBe("explicit");
    expect(await rpc.request("echo", "generated")).toBe("generated");
    await expect(rpc.request("echo", "old", { id: 1 })).rejects.toThrow("already used");
    await expect(rpc.request("echo", "old", { id: 2 })).rejects.toThrow("already used");
    expect(await rpc.request("echo", "second explicit", { id: "x" })).toBe("second explicit");
    await expect(rpc.request("echo", "over capacity", { id: "y" })).rejects.toThrow(
      "explicit id limit",
    );
    expect(await rpc.request("echo", "automatic still works")).toBe("automatic still works");
  } finally {
    rpc.close();
  }
});

it("final notifications are drained before the peer detaches at stdout close", async () => {
  const proc = child(
    `require('node:readline').createInterface({input:process.stdin}).once('line',()=>{console.log(JSON.stringify({method:'final',params:'complete'}));process.stdin.destroy();});`,
  );
  const rpc = new JsonRpcPeer(proc);
  const messages: unknown[] = [];
  rpc.onNotification = (message) => messages.push(message);
  await rpc.notify("finish");
  await proc.exited;
  expect(messages).toEqual([{ method: "final", params: "complete" }]);
});
