import { afterEach, describe, expect, it, vi } from "vitest";
import { PROCESS_TEST_TIMEOUT } from "./testing/cli.ts";
import { JsonRpcPeer, MethodNotFound } from "./jsonrpc.ts";
import { spawnSupervised, type SupervisedProcess } from "./process.ts";

const processes: SupervisedProcess[] = [];
function peer(onInput: string, options: ConstructorParameters<typeof JsonRpcPeer>[1] = {}) {
  const proc = spawnSupervised({
    command: process.execPath,
    args: [
      "-e",
      `
    const { createInterface } = require('node:readline');
    const send = m => console.log(JSON.stringify(m));
    createInterface({input:process.stdin}).on('line', line => {
      const m = JSON.parse(line);
      ${onInput}
    });
  `,
    ],
    env: {},
    name: "fake-jsonrpc-peer",
  });
  processes.push(proc);
  return { proc, rpc: new JsonRpcPeer(proc, { timeoutMs: PROCESS_TEST_TIMEOUT, ...options }) };
}
afterEach(async () => {
  await Promise.all(processes.splice(0).map((proc) => proc.stop({ graceMs: 0 })));
});

describe("JSON-RPC stdio", () => {
  it("matches responses to concurrent string and numeric ids and records both directions", async () => {
    const frames: Array<[string, unknown]> = [];
    const { rpc } = peer(`send({id:m.id, result:m.params});`, {
      onFrame: (direction, message) => frames.push([direction, message]),
    });
    expect(
      await Promise.all([
        rpc.request("echo", { value: "string" }, { id: "my-id" }),
        rpc.request("echo", { value: "number" }),
      ]),
    ).toEqual([{ value: "string" }, { value: "number" }]);
    expect(frames).toEqual(
      expect.arrayContaining([
        ["send", { jsonrpc: "2.0", id: "my-id", method: "echo", params: { value: "string" } }],
        ["recv", { id: "my-id", result: { value: "string" } }],
      ]),
    );
  });
  it("answers incoming extension requests with string and numeric ids", async () => {
    const { rpc } = peer(
      `if(m.method==='start') { send({method:'cursor/ask_question',id:'extension',params:{question:'tabs?'}}); send({method:'approval',id:88}); } else if(m.id==='extension') { send({id:1,result:m.result}); } else if(m.id===88) { send({method:'answer',params:m.result}); }`,
    );
    rpc.onRequest = ({ method, params }) =>
      method === "cursor/ask_question" ? { answer: "tabs", original: params } : "approved";
    const notification = new Promise<unknown>((resolve) => {
      rpc.onNotification = ({ params }) => resolve(params);
    });
    expect(await rpc.request("start")).toEqual({ answer: "tabs", original: { question: "tabs?" } });
    expect(await notification).toBe("approved");
  });
  it("delivers notifications and sends notifications without a request id", async () => {
    const { rpc } = peer(
      `if(m.method === 'greet' && !('id' in m)) send({method:'greeting',params:m.params});`,
    );
    const received = new Promise<unknown>((resolve) => {
      rpc.onNotification = resolve;
    });
    rpc.notify("greet", "hello");
    expect(await received).toEqual({ method: "greeting", params: "hello" });
  });
  it("rejects unanswered requests at their deadline and accepts the next request", async () => {
    const { rpc } = peer(`if(m.method==='echo') send({id:m.id,result:'still works'});`);
    await expect(rpc.request("silent", undefined, { timeoutMs: 50 })).rejects.toThrow("timed out");
    expect(await rpc.request("echo")).toBe("still works");
  });
  it("allows interactive requests to remain pending when deadlines are disabled", async () => {
    const { rpc } = peer(
      `if(m.method === 'wait') globalThis.waiting = m.id; else if(m.method === 'release') send({id:globalThis.waiting,result:'approved'});`,
      { timeoutMs: null },
    );
    vi.useFakeTimers();
    try {
      const pending = rpc.request("wait").then(
        (value) => ({ result: value }),
        (error: unknown) => ({ error: String(error) }),
      );
      await vi.advanceTimersByTimeAsync(60_000);
      rpc.notify("release");
      expect(await pending).toEqual({ result: "approved" });
    } finally {
      vi.useRealTimers();
    }
  });
  it("cancels pending requests without disrupting subsequent requests", async () => {
    const { rpc } = peer(`if(m.method==='echo') send({id:m.id,result:'next'});`);
    const controller = new AbortController();
    const pending = rpc.request("silent", undefined, { signal: controller.signal, id: "cancel" });
    const rejected = expect(pending).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await rejected;
    expect(await rpc.request("echo", undefined, { id: "next" })).toBe("next");
    await expect(rpc.request("silent", undefined, { signal: controller.signal })).rejects.toThrow(
      "cancelled",
    );
  });
  it("rejects all pending requests on process exit and rejects later writes", async () => {
    const { rpc, proc } = peer(`process.exit(2);`);
    await Promise.all([
      expect(rpc.request("exit")).rejects.toThrow("process exited"),
      expect(rpc.request("pending")).rejects.toThrow("process exited"),
    ]);
    await proc.exited;
    await expect(rpc.request("too-late")).rejects.toThrow("process exited");
  });
  it("rejects a request at child exit while a grandchild still holds stdout open", async () => {
    const descendant = `console.log('pipe-held');process.send('ready');setInterval(()=>{},1000);`;
    const proc = spawnSupervised({
      command: process.execPath,
      args: [
        "-e",
        `require('node:readline').createInterface({input:process.stdin}).once('line',()=>{const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',process.stdout,process.stderr,'ipc']});c.on('message',()=>process.exit(0));});`,
      ],
      env: {},
      name: "pending-pipe",
      killGroupOnExit: false,
    });
    processes.push(proc);
    const rpc = new JsonRpcPeer(proc, { timeoutMs: PROCESS_TEST_TIMEOUT });
    let pipesClosed = false;
    void proc.exited.then(() => {
      pipesClosed = true;
    });
    await expect(rpc.request("pending")).rejects.toThrow("process exited");
    expect(pipesClosed).toBe(false);
    await proc.stop({ graceMs: 0 });
    expect(pipesClosed).toBe(true);
  });
  it("rejects every pending request and reports EPIPE while the peer is still alive", async () => {
    const failures: Error[] = [];
    // Close the OS read end before Node can retain a separate stdin handle.
    const proc = spawnSupervised({
      command: "/bin/sh",
      args: [
        "-c",
        `IFS= read -r line; exec 0<&-; printf '%s\\n' '{"method":"stdin-closed"}'; exec "$1" -e 'setInterval(()=>{},1000)'`,
        "epipe-peer",
        process.execPath,
      ],
      env: {},
      name: "closed-stdin-peer",
    });
    processes.push(proc);
    const rpc = new JsonRpcPeer(proc, {
      timeoutMs: null,
      onError: (error) => failures.push(error),
    });
    const closed = new Promise<void>((resolve) => {
      rpc.onNotification = ({ method }) => {
        if (method === "stdin-closed") resolve();
      };
    });
    const pending = rpc.request("pending").then(
      () => "resolved",
      (error: unknown) => String(error),
    );
    await closed;
    const write = rpc.request("write").then(
      () => "resolved",
      (error: unknown) => String(error),
    );
    expect(await pending).toContain("EPIPE");
    expect(await write).toContain("EPIPE");
    expect(failures.map((error) => error.message).join(" ")).toContain("EPIPE");
    expect(proc.signal.aborted).toBe(false);
  });
  it("reports malformed lines and continues handling valid frames", async () => {
    const malformed: string[] = [];
    const { rpc } = peer(
      `console.log('not-json'); console.log('null'); send({id:m.id,result:'ok'});`,
      { onMalformed: (line) => malformed.push(line) },
    );
    expect(await rpc.request("echo")).toBe("ok");
    expect(malformed).toEqual(["not-json", "null"]);
  });
  it("returns method-not-found for explicitly unsupported requests", async () => {
    const { rpc } = peer(
      `if(m.method==='start') send({method:'missing',id:'server'}); else if(m.id==='server') send({id:1,result:m.error});`,
    );
    expect(await rpc.request("start")).toEqual({ code: -32601, message: "unhandled request" });
  });
  it.each(["cursor/ask_question", "cursor/create_plan"])(
    "returns internal-error when the %s handler fails",
    async (method) => {
      const { rpc } = peer(
        `if(m.method==='start') send({method:${JSON.stringify(method)},id:'server'});else if(m.id==='server')send({id:1,result:m.error});`,
      );
      rpc.onRequest = () => {
        throw new Error("handler failed");
      };
      expect(await rpc.request("start")).toEqual({ code: -32603, message: "handler failed" });
    },
  );
  it("maps an explicit MethodNotFound from a handler to method-not-found", async () => {
    const { rpc } = peer(
      `if(m.method==='start')send({method:'unknown',id:'server'});else if(m.id==='server')send({id:1,result:m.error});`,
    );
    rpc.onRequest = () => {
      throw new MethodNotFound("unsupported extension");
    };
    expect(await rpc.request("start")).toEqual({ code: -32601, message: "unsupported extension" });
  });
  it("rejects provider error responses without dropping the next response", async () => {
    const { rpc } = peer(
      `send(m.method==='bad' ? {id:m.id,error:{code:123,message:'failure'}} : {id:m.id,result:'ok'});`,
    );
    await expect(rpc.request("bad")).rejects.toThrow("failure");
    expect(await rpc.request("good")).toBe("ok");
  });
});
