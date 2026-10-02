import { expect, test } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

test("an asynchronous daemon spawn failure closes logs and lets the supervisor process terminate", async () => {
  const api = fileURLToPath(new URL("./index.ts", import.meta.url));
  const script = `
    const {runSupervisor}=await import(${JSON.stringify(api)});
    const {ChildProcess}=await import('node:child_process');
    const {Writable}=await import('node:stream');
    const output=new Writable({write(c,e,cb){cb()},final(cb){process.stdout.write('output closed\\n');cb()}});
    const errors=new Writable({write(c,e,cb){cb()},final(cb){process.stdout.write('errors closed\\n');cb()}});
    try {
      await runSupervisor({output,errors,dailyUpdates:true,
        spawnDaemon(){const child=new ChildProcess();queueMicrotask(()=>child.emit('error',Object.assign(new Error('EAGAIN'),{code:'EAGAIN'})));return child},
        launchUpdate(){throw new Error('unexpected updater')},journalPending:()=>false,
        schedule(ms,callback){const t=setTimeout(callback,ms);return()=>clearTimeout(t)},
        subscribeStop:()=>()=>{},report:()=>{}
      });
    } catch(error) {process.stdout.write(error.message+'\\n');process.exitCode=1}
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    errors = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-65536);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors = (errors + chunk.toString()).slice(-65536);
  });
  try {
    const [code] = await once(child, "close");
    expect(errors).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(code).toBe(1);
    expect(output).toContain("EAGAIN");
    expect(output).toContain("output closed");
    expect(output).toContain("errors closed");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const close = once(child, "close");
      child.kill("SIGKILL");
      await close;
    }
  }
});
