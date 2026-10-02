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
    name: "replacement-rpc",
  });
  processes.push(proc);
  return proc;
}

it.each([undefined, 1, "reused"])(
  "replacement peers fence old generated and explicit ids: %s",
  async (id) => {
    const proc = child(
      `let old;require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='old'){old=m.id;console.log(JSON.stringify({method:'seen'}));}else{console.log(JSON.stringify({id:old,result:'STALE'}));console.log(JSON.stringify({id:m.id,result:'FRESH'}));}});`,
    );
    const old = new JsonRpcPeer(proc, { timeoutMs: PROCESS_TEST_TIMEOUT });
    const seen = new Promise<void>((resolve) => {
      old.onNotification = () => resolve();
    });
    const pending = old
      .request("old", undefined, id === undefined ? {} : { id })
      .catch((error: unknown) => String(error));
    await seen;
    old.close();
    expect(await pending).toContain("peer closed");
    const replacement = new JsonRpcPeer(proc, { timeoutMs: PROCESS_TEST_TIMEOUT });
    try {
      await expect(replacement.request("fresh", undefined, { id: id ?? 1 })).rejects.toThrow(
        "already used",
      );
      expect(await replacement.request("fresh")).toBe("FRESH");
    } finally {
      replacement.close();
    }
  },
);

it("concurrent peers correlate distinct requests on one process", async () => {
  const proc = child(
    `let old;require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='old'){old=m.id;console.log(JSON.stringify({method:'seen'}));}else{console.log(JSON.stringify({id:old,result:'OLD'}));console.log(JSON.stringify({id:m.id,result:'FRESH'}));}});`,
  );
  const old = new JsonRpcPeer(proc, { timeoutMs: PROCESS_TEST_TIMEOUT });
  const other = new JsonRpcPeer(proc, { timeoutMs: PROCESS_TEST_TIMEOUT });
  const seen = new Promise<void>((resolve) => {
    old.onNotification = () => resolve();
  });
  try {
    const pending = old.request("old");
    await seen;
    const fresh = other.request("fresh");
    expect(await Promise.all([pending, fresh])).toEqual(["OLD", "FRESH"]);
  } finally {
    old.close();
    other.close();
  }
});

it("replacements retain the process byte bound while old stdin writes are blocked", async () => {
  const proc = child("console.log('ready');setInterval(()=>{},1000);");
  await once(proc.stdout, "line");
  const limits = { maxQueuedBytes: 600000, maxMessageBytes: 600000, timeoutMs: null };
  const old = new JsonRpcPeer(proc, limits);
  const active = old.notify("blocked", "x".repeat(500000)).catch((error: unknown) => String(error));
  old.close();
  expect(await active).toContain("peer closed");
  for (let i = 0; i < 20; i++) {
    const replacement = new JsonRpcPeer(proc, {
      ...limits,
      maxQueuedBytes: i % 2 ? 1200000 : 600000,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        replacement.notify("extra", "x".repeat(200000)).then(
          () => "accepted",
          (error: unknown) => String(error),
        ),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("still pending"), PROCESS_TEST_TIMEOUT / 2);
        }),
      ]);
      expect(result).toContain("write queue exceeded limit");
      expect(proc.stdin.writableLength).toBeLessThanOrEqual(600000);
    } finally {
      clearTimeout(timer);
      replacement.close();
    }
  }
  expect(proc.signal.aborted).toBe(false);
});

it("replacement cannot reset the bounded explicit-id history", async () => {
  const proc = child(
    `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);console.log(JSON.stringify({id:m.id,result:m.params}));});`,
  );
  for (const id of ["one", "two"]) {
    const rpc = new JsonRpcPeer(proc, { maxExplicitIds: 2, timeoutMs: PROCESS_TEST_TIMEOUT });
    try {
      expect(await rpc.request("echo", id, { id })).toBe(id);
    } finally {
      rpc.close();
    }
  }
  const replacement = new JsonRpcPeer(proc, {
    maxExplicitIds: 10,
    timeoutMs: PROCESS_TEST_TIMEOUT,
  });
  try {
    await expect(replacement.request("echo", "excess", { id: "three" })).rejects.toThrow(
      "explicit id limit",
    );
    expect(await replacement.request("echo", "automatic")).toBe("automatic");
  } finally {
    replacement.close();
  }
});

it("replacement resumes after old bytes drain and never sends disposed queued notifications", async () => {
  const proc = child(
    `process.on('SIGUSR1',()=>{require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);console.log(JSON.stringify({method:'received',params:m.method}));if(m.method==='echo')console.log(JSON.stringify({id:m.id,result:m.params}));});});setInterval(()=>{},1000);console.log(process.pid);`,
  );
  const [pid] = await once(proc.stdout, "line");
  const limits = {
    maxQueuedBytes: 600000,
    maxMessageBytes: 600000,
    timeoutMs: PROCESS_TEST_TIMEOUT,
  };
  const old = new JsonRpcPeer(proc, limits);
  const flood = old.notify("flood", "x".repeat(500000)).catch((error: unknown) => String(error));
  const discarded = old
    .notify("discarded", "x".repeat(1000))
    .catch((error: unknown) => String(error));
  old.close();
  expect(await flood).toContain("peer closed");
  expect(await discarded).toContain("peer closed");
  const replacement = new JsonRpcPeer(proc, limits);
  const received: unknown[] = [];
  replacement.onNotification = (message) => received.push(message.params);
  try {
    const resumed = replacement.request("echo", "resumed");
    process.kill(Number(pid), "SIGUSR1");
    expect(await resumed).toBe("resumed");
    await replacement.notify("second", "x".repeat(500000));
    expect(await replacement.request("echo", "drained")).toBe("drained");
    expect(received).toEqual(["flood", "echo", "second", "echo"]);
  } finally {
    replacement.close();
  }
});
