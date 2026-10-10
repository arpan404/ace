import { afterEach, expect, it } from "vitest";
import { JsonRpcPeer } from "./jsonrpc.ts";
import { spawnSupervised, type SupervisedProcess } from "./process.ts";

const processes: SupervisedProcess[] = [];
function unarmedDeadline(): void {
  throw new Error("deadline not armed");
}
afterEach(async () => {
  await Promise.all(processes.splice(0).map((proc) => proc.stop({ graceMs: 0 })));
});
function child(script: string) {
  const proc = spawnSupervised({
    command: process.execPath,
    args: ["-e", script],
    env: {},
    name: "rpc-boundary",
  });
  processes.push(proc);
  return proc;
}

it("a failed receive observer rejects pending RPCs with its cause without breaking another peer's pipe", async () => {
  const proc = child(
    `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);console.log(JSON.stringify({id:m.id,result:'alive'}));});`,
  );
  const failure = new Error("receive observer failed");
  const rpc = new JsonRpcPeer(proc, {
    onFrame: (direction) => {
      if (direction === "recv") throw failure;
    },
  });
  try {
    await expect(rpc.request("echo", undefined, { timeoutMs: 1000 })).rejects.toThrow(
      "receive observer failed",
    );
    const active = new JsonRpcPeer(proc);
    try {
      expect(await active.request("echo")).toBe("alive");
    } finally {
      active.close();
    }
  } finally {
    rpc.close();
  }
});

it("injected deadlines expire silent requests without waiting on wall time", async () => {
  let expire: () => void = unarmedDeadline;
  const rpc = new JsonRpcPeer(
    child(
      `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='silent')console.log(JSON.stringify({method:'seen'}));else console.log(JSON.stringify({id:m.id,result:'alive'}));});`,
    ),
    {
      timeoutMs: 100000,
      schedule: (_delayMs, callback) => {
        expire = callback;
        return () => {
          expire = () => {};
        };
      },
    },
  );
  const seen = new Promise<void>((resolve) => {
    rpc.onNotification = () => resolve();
  });
  try {
    const pending = rpc.request("silent").catch((error: unknown) => String(error));
    await seen;
    expire();
    expect(await pending).toContain("timed out: silent");
    expect(await rpc.request("echo", undefined, { timeoutMs: null })).toBe("alive");
  } finally {
    rpc.close();
  }
});

it("lenient envelope parsing preserves unknown fields and keeps receiving after malformed frames", async () => {
  const raw: unknown[] = [],
    malformed: string[] = [];
  const rpc = new JsonRpcPeer(
    child(
      `require('node:readline').createInterface({input:process.stdin}).once('line',line=>{const m=JSON.parse(line);console.log('[]');console.log(JSON.stringify({id:m.id,jsonrpc:'future',result:{custom:[1,'x']},extension:{nested:true}}));});`,
    ),
    {
      onFrame: (direction, frame) => {
        if (direction === "recv") raw.push(frame);
      },
      onMalformed: (line) => malformed.push(line),
    },
  );
  try {
    expect(await rpc.request("echo")).toEqual({ custom: [1, "x"] });
    expect(malformed).toEqual(["[]"]);
    expect(raw).toEqual([
      [],
      { id: 1, jsonrpc: "future", result: { custom: [1, "x"] }, extension: { nested: true } },
    ]);
  } finally {
    rpc.close();
  }
});

it("a failed deadline scheduler releases pending admission for the next request", async () => {
  const rpc = new JsonRpcPeer(
    child(
      `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);console.log(JSON.stringify({id:m.id,result:'next'}));});`,
    ),
    {
      maxPendingRequests: 1,
      schedule: () => {
        throw new Error("deadline unavailable");
      },
    },
  );
  try {
    await expect(rpc.request("silent")).rejects.toThrow("deadline unavailable");
    expect(await rpc.request("echo", undefined, { timeoutMs: null })).toBe("next");
  } finally {
    rpc.close();
  }
});
