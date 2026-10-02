import { expect, it } from "vitest";
import { spawnSupervised } from "./process.ts";

it("repeatedly disposed peers release captured payloads while the process remains alive", async () => {
  const processUrl = new URL("./process.ts", import.meta.url).href;
  const rpcUrl = new URL("./jsonrpc.ts", import.meta.url).href;
  const script = `
    import {spawnSupervised} from ${JSON.stringify(processUrl)};
    import {JsonRpcPeer} from ${JSON.stringify(rpcUrl)};
    const proc=spawnSupervised({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:{},name:'live-owner'});
    const refs=[];
    function dispose() {
      const payload=new Uint8Array(65536);
      refs.push(new WeakRef(payload));
      const rpc=new JsonRpcPeer(proc,{onFrame:()=>payload[0]});
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
}, 15000);
