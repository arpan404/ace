import { expect, it } from "vitest";
import { spawnSupervised } from "./process.ts";
import { PROCESS_TEST_TIMEOUT } from "./testing/cli.ts";

it(
  "repeatedly disposed peers release captured payloads while the process remains alive",
  async () => {
    const processUrl = new URL("./process.ts", import.meta.url).href;
    const rpcUrl = new URL("./jsonrpc.ts", import.meta.url).href;
    const script = `
    import {spawnSupervised} from ${JSON.stringify(processUrl)};
    import {JsonRpcPeer} from ${JSON.stringify(rpcUrl)};
    const proc=spawnSupervised({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:{},name:'live-owner'});
    const refs=[];
    const blocked=new JsonRpcPeer(proc,{maxQueuedBytes:600000,maxMessageBytes:600000});
    void blocked.notify('blocked','x'.repeat(500000)).catch(()=>{});
    blocked.close();
    function dispose() {
      const payload=new Uint8Array(65536);
      refs.push(new WeakRef(payload));
      const rpc=new JsonRpcPeer(proc,{onFrame:()=>payload[0]});
      void rpc.notify('discard').catch(()=>{});
      rpc.close();
    }
    try {
      for(let i=0;i<128;i++) dispose();
      for(let i=0;i<10;i++) {await new Promise(r=>setImmediate(r));globalThis.gc();}
      console.log('retained:'+refs.filter(ref=>ref.deref()!==undefined).length);
      console.log('alive:'+!proc.signal.aborted);
    } finally {await proc.stop({graceMs:0});}
  `;
    const owner = spawnSupervised({
      command: process.execPath,
      args: ["--expose-gc", "--input-type=module", "-e", script],
      env: {},
      name: "gc-disposal",
    });
    const lines: string[] = [],
      errors: string[] = [];
    owner.stdout.on("line", (line) => lines.push(line));
    owner.stderr.on("line", (line) => errors.push(line));
    try {
      expect((await owner.exited).code, errors.join("\n")).toBe(0);
      expect(lines).toEqual(["retained:0", "alive:true"]);
    } finally {
      await owner.stop({ graceMs: 0 });
    }
  },
  PROCESS_TEST_TIMEOUT,
);

it(
  "stdout completion detaches captured callbacks while the exited owner is retained",
  async () => {
    const processUrl = new URL("./process.ts", import.meta.url).href;
    const rpcUrl = new URL("./jsonrpc.ts", import.meta.url).href;
    const script = `
    import {spawnSupervised} from ${JSON.stringify(processUrl)};
    import {JsonRpcPeer} from ${JSON.stringify(rpcUrl)};
    const proc=spawnSupervised({command:process.execPath,args:['-e',"require('node:readline').createInterface({input:process.stdin}).once('line',()=>{console.log(JSON.stringify({method:'final',params:'complete'}));process.stdin.destroy();});"],env:{},name:'final-owner'});
    const refs=[], messages=[];
    async function finish() {
      const payload=new Uint8Array(65536);
      refs.push(new WeakRef(payload));
      const rpc=new JsonRpcPeer(proc,{onFrame:()=>payload[0]});
      rpc.onNotification=m=>messages.push(m.params);
      await rpc.notify('finish');
      await proc.exited;
    }
    try {
      await finish();
      for(let i=0;i<10;i++) {await new Promise(r=>setImmediate(r));globalThis.gc();}
      console.log('retained:'+refs.filter(ref=>ref.deref()!==undefined).length);
      console.log('messages:'+JSON.stringify(messages));
      console.log('ended:'+proc.signal.aborted);
    } finally {await proc.stop({graceMs:0});}
  `;
    const owner = spawnSupervised({
      command: process.execPath,
      args: ["--expose-gc", "--input-type=module", "-e", script],
      env: {},
      name: "gc-final-disposal",
    });
    const lines: string[] = [],
      errors: string[] = [];
    owner.stdout.on("line", (line) => lines.push(line));
    owner.stderr.on("line", (line) => errors.push(line));
    try {
      expect((await owner.exited).code, errors.join("\n")).toBe(0);
      expect(lines).toEqual(["retained:0", 'messages:["complete"]', "ended:true"]);
    } finally {
      await owner.stop({ graceMs: 0 });
    }
  },
  PROCESS_TEST_TIMEOUT,
);
