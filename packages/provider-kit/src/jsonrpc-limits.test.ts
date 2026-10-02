import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { JsonRpcPeer } from "./jsonrpc.ts";
import { spawnSupervised, type SupervisedProcess } from "./process.ts";
import { PROCESS_TEST_TIMEOUT } from "./testing/cli.ts";

const processes: SupervisedProcess[] = [];
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

it("pending capacity rejects excess requests and cancellation releases it", async () => {
  const proc = child(echo);
  const rpc = new JsonRpcPeer(proc, { maxPendingRequests: 1, timeoutMs: null });
  const controller = new AbortController();
  const pending = rpc
    .request("silent", undefined, { signal: controller.signal })
    .catch((error: unknown) => String(error));
  try {
    await expect(rpc.request("echo", "excess")).rejects.toThrow("pending request limit");
    controller.abort(new Error("cancelled"));
    expect(await pending).toContain("cancelled");
    expect(await rpc.request("echo", "next")).toBe("next");
  } finally {
    rpc.close();
  }
});

it("message limits reject requests and notify reports the failed send", async () => {
  const proc = child(echo);
  const errors: string[] = [];
  const rpc = new JsonRpcPeer(proc, {
    maxMessageBytes: 128,
    onError: (error) => errors.push(error.message),
  });
  try {
    await expect(rpc.request("echo", "é".repeat(50))).rejects.toThrow("message exceeded limit");
    await expect(rpc.notify("large", "é".repeat(50))).rejects.toThrow("message exceeded limit");
    expect(errors.join(" ")).toContain("message exceeded limit");
    expect(await rpc.request("echo", "small")).toBe("small");
  } finally {
    rpc.close();
  }
});

it("nonreading peers retain byte capacity after cancellation and dispose blocked writes", async () => {
  const proc = child(`console.log('ready');setInterval(()=>{},1000);`);
  await once(proc.stdout, "line");
  const rpc = new JsonRpcPeer(proc, {
    maxQueuedBytes: 600000,
    maxMessageBytes: 600000,
    timeoutMs: null,
  });
  const controller = new AbortController();
  const pending = rpc
    .request("blocked", "x".repeat(500000), { signal: controller.signal })
    .catch((error: unknown) => String(error));
  const failedNotify = rpc.notify("extra", "x".repeat(200000));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const admission = await Promise.race([
      failedNotify.then(
        () => "accepted",
        (error: unknown) => String(error),
      ),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("still pending"), PROCESS_TEST_TIMEOUT / 2);
      }),
    ]);
    expect(admission).toContain("write queue exceeded limit");
    controller.abort(new Error("cancelled"));
    expect(await pending).toContain("cancelled");
    await expect(rpc.request("extra", "x".repeat(200000))).rejects.toThrow(
      "write queue exceeded limit",
    );
    expect(proc.stdin.writableLength).toBeLessThanOrEqual(600000);
    const notification = rpc.notify("queued", "queued");
    rpc.close();
    await expect(notification).rejects.toThrow("peer closed");
    expect(proc.signal.aborted).toBe(false);
  } finally {
    clearTimeout(timer);
    rpc.close();
  }
});

it("queued cancelled requests are never delivered once a blocked peer reads again", async () => {
  const proc = child(
    `process.on('SIGUSR1',()=>{require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);console.log(JSON.stringify({method:'received',params:m.method}));if(m.method==='echo')console.log(JSON.stringify({id:m.id,result:m.params}));});});setInterval(()=>{},1000);console.log(process.pid);`,
  );
  const [pid] = await once(proc.stdout, "line");
  const rpc = new JsonRpcPeer(proc, {
    maxQueuedBytes: 1000000,
    maxMessageBytes: 600000,
    timeoutMs: null,
  });
  const received: unknown[] = [];
  rpc.onNotification = (message) => received.push(message.params);
  const flood = rpc.notify("flood", "x".repeat(500000));
  const controller = new AbortController();
  const pending = rpc
    .request("cancelled", "x".repeat(1000), { signal: controller.signal })
    .catch((error: unknown) => String(error));
  controller.abort(new Error("cancelled"));
  try {
    expect(await pending).toContain("cancelled");
    process.kill(Number(pid), "SIGUSR1");
    await flood;
    expect(await rpc.request("echo", "resumed")).toBe("resumed");
    expect(received).toEqual(["flood", "echo"]);
  } finally {
    rpc.close();
  }
});
