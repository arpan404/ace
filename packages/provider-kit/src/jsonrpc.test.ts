import { afterEach, describe, expect, it } from "vitest";
import { JsonRpcPeer } from "./jsonrpc.ts";
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
  return { proc, rpc: new JsonRpcPeer(proc, options) };
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
  it("cancels pending requests and allows the cancelled id to be reused", async () => {
    const { rpc } = peer(`if(m.method==='echo') send({id:m.id,result:'reused'});`);
    const controller = new AbortController();
    const pending = rpc.request("silent", undefined, { signal: controller.signal, id: "cancel" });
    const rejected = expect(pending).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await rejected;
    expect(await rpc.request("echo", undefined, { id: "cancel" })).toBe("reused");
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
  it("reports malformed lines and continues handling valid frames", async () => {
    const malformed: string[] = [];
    const { rpc } = peer(
      `console.log('not-json'); console.log('null'); send({id:m.id,result:'ok'});`,
      { onMalformed: (line) => malformed.push(line) },
    );
    expect(await rpc.request("echo")).toBe("ok");
    expect(malformed).toEqual(["not-json", "null"]);
  });
  it("returns handler failures as JSON-RPC errors without killing the transport", async () => {
    const { rpc } = peer(
      `if(m.method==='start') send({method:'missing',id:'server'}); else if(m.id==='server') send({id:1,result:m.error});`,
    );
    expect(await rpc.request("start")).toEqual({ code: -32601, message: "unhandled request" });
  });
  it("rejects provider error responses without dropping the next response", async () => {
    const { rpc } = peer(
      `send(m.method==='bad' ? {id:m.id,error:{code:123,message:'failure'}} : {id:m.id,result:'ok'});`,
    );
    await expect(rpc.request("bad")).rejects.toThrow("failure");
    expect(await rpc.request("good")).toBe("ok");
  });
});
