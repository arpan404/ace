import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { probeOutput, spawnSupervised, type SupervisedProcess } from "./process.ts";

const owned: SupervisedProcess[] = [];
function child(script: string, env: NodeJS.ProcessEnv = {}) {
  const proc = spawnSupervised({
    command: process.execPath,
    args: ["-e", script],
    env,
    name: "test-child",
  });
  owned.push(proc);
  return proc;
}
afterEach(async () => {
  await Promise.all(owned.splice(0).map((proc) => proc.stop({ graceMs: 0 })));
});

describe("supervised processes", () => {
  it("reports a clean exit and ends the lifetime signal after draining final output", async () => {
    const proc = child(`console.log('final'); process.exitCode = 0`);
    const lines: string[] = [];
    proc.stdout.on("line", (line) => lines.push(line));
    expect(await proc.exited).toEqual({ code: 0, signal: null, reason: "exit" });
    expect(lines).toEqual(["final"]);
    expect(proc.signal.aborted).toBe(true);
  });
  it("reports a crashing child without unhandled pipe errors", async () => {
    const proc = child(`throw new Error('synthetic crash')`);
    const errors: string[] = [];
    proc.stderr.on("line", (line) => errors.push(line));
    expect(await proc.exited).toEqual({ code: 1, signal: null, reason: "exit" });
    expect(errors.join("\n")).toContain("synthetic crash");
  });
  it("reports a missing executable as a spawn failure", async () => {
    const proc = spawnSupervised({
      command: "/no-such-provider-kit-executable",
      env: {},
      name: "missing",
    });
    expect((await proc.exited).reason).toBe("spawn-error");
    expect(proc.signal.aborted).toBe(true);
    expect(await proc.stop()).toEqual(await proc.exited);
  });
  it("gives a cooperative child time to finish on SIGTERM", async () => {
    const proc = child(
      `process.on('SIGTERM', () => process.exit(0)); console.log('ready'); setInterval(() => {}, 1000)`,
    );
    await once(proc.stdout, "line");
    expect(await proc.stop({ graceMs: 1000 })).toEqual({
      code: 0,
      signal: null,
      reason: "stopped",
    });
  });
  it("waits for the grace period then kills a child that ignores SIGTERM", async () => {
    const proc = child(
      `process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)`,
    );
    await once(proc.stdout, "line");
    const started = performance.now();
    const stopped = proc.stop({ graceMs: 50 });
    const alsoStopped = proc.stop({ graceMs: 50 });
    expect(await stopped).toEqual({ code: null, signal: "SIGKILL", reason: "stopped" });
    expect(await alsoStopped).toEqual({ code: null, signal: "SIGKILL", reason: "stopped" });
    expect(performance.now() - started).toBeGreaterThanOrEqual(45);
  });
  it("kills an uncooperative grandchild that keeps the output pipe open", async () => {
    const descendant = `process.on('SIGTERM', () => {}); console.log('grandchild-ready'); setInterval(() => {}, 1000)`;
    const proc = child(
      `const {spawn} = require('node:child_process'); process.on('SIGTERM',()=>{}); spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:['ignore', process.stdout, process.stderr]}); setInterval(()=>{},1000)`,
    );
    expect(await once(proc.stdout, "line")).toEqual(["grandchild-ready"]);
    const closed = once(proc.stdout, "close");
    expect((await proc.stop({ graceMs: 20 })).signal).toBe("SIGKILL");
    // close/exited cannot complete while the grandchild still holds its inherited pipe.
    await closed;
  });
  it("kills remaining grandchildren when the direct child exits naturally", async () => {
    const descendant = `console.log('grandchild-ready'); process.send('ready'); setInterval(() => {}, 1000)`;
    const proc = child(
      `const {spawn} = require('node:child_process'); const c = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:['ignore',process.stdout,process.stderr,'ipc']}); c.on('message', () => process.exit(0));`,
    );
    expect(await once(proc.stdout, "line")).toEqual(["grandchild-ready"]);
    expect((await proc.exited).code).toBe(0);
  });
  it.each(["exit", "SIGTERM", "SIGINT"] as const)(
    "kills owned services when its owner ends via %s",
    async (termination) => {
      const moduleUrl = new URL("./process.ts", import.meta.url).href;
      const service = `const server=require('node:net').createServer().listen(0, '127.0.0.1', function(){console.log(this.address().port);});process.on('SIGTERM',()=>{console.log('transcript-flushed');server.close(()=>process.exit(0));});`;
      const script = `import {spawnSupervised,installShutdownHandlers} from ${JSON.stringify(moduleUrl)};
      ${termination === "exit" ? "" : "installShutdownHandlers({graceMs:1000});"}
      const p = spawnSupervised({command:process.execPath,args:['-e',${JSON.stringify(service)}],env:{},name:'owned-service'});
      let sent=false;
      p.stdout.on('line', line => { console.log(line); if(!sent) {sent=true; ${termination === "exit" ? "process.exit(0)" : `process.kill(process.pid, '${termination}')`}; } });`;
      // An ordinary parent, outside the test supervisor's group, tests the kit's exit hooks.
      const owner = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const lines = createInterface({ input: owner.stdout });
      const closed = once(owner, "close");
      const output: string[] = [];
      lines.on("line", (line) => output.push(line));
      const [port] = await once(lines, "line");
      expect(await closed).toEqual(termination === "exit" ? [0, null] : [null, termination]);
      if (termination !== "exit") expect(output).toContain("transcript-flushed");
      const socket = connect({ host: "127.0.0.1", port: Number(port) });
      const result = await new Promise<string>((resolve) => {
        socket.once("connect", () => {
          socket.destroy();
          resolve("still-serving");
        });
        socket.once("error", (error: NodeJS.ErrnoException) =>
          resolve(error.code ?? "unknown-error"),
        );
      });
      expect(result).toBe("ECONNREFUSED");
    },
  );
  it.each(["default", "disposed"])(
    "leaves application signal handling alone in %s mode",
    async (mode) => {
      const moduleUrl = new URL("./process.ts", import.meta.url).href;
      const service = `require('node:net').createServer(socket=>socket.end('alive')).listen(0,'127.0.0.1',function(){console.log(this.address().port);});`;
      const script = `import {spawnSupervised,installShutdownHandlers} from ${JSON.stringify(moduleUrl)};
      ${mode === "disposed" ? "installShutdownHandlers()();" : ""}
      let port;
      process.on('SIGTERM',()=> { console.log('application-handled'); const socket=(awaitNet)(port); });
      function awaitNet(p) { import('node:net').then(({connect})=> { const s=connect({host:'127.0.0.1',port:p});s.on('data',data=>{console.log('provider-'+data);process.exit(0);});s.on('error',()=>process.exit(2)); }); }
      const proc=spawnSupervised({command:process.execPath,args:['-e',${JSON.stringify(service)}],env:{},name:'service'});
      proc.stdout.once('line',line=>{port=Number(line);process.kill(process.pid,'SIGTERM');});`;
      const owner = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const output: string[] = [];
      createInterface({ input: owner.stdout }).on("line", (line) => output.push(line));
      try {
        expect(await once(owner, "close")).toEqual([0, null]);
        expect(output).toEqual(["application-handled", "provider-alive"]);
      } finally {
        owner.kill("SIGKILL");
      }
    },
  );
  it("repeated ownership releases process exit listeners without warning events", async () => {
    const warnings: string[] = [];
    const onWarning = (warning: Error) => {
      if (warning.name === "MaxListenersExceededWarning") warnings.push(warning.message);
    };
    process.on("warning", onWarning);
    try {
      for (let i = 0; i < 20; i++) {
        const proc = spawnSupervised({
          command: "/bin/sh",
          args: ["-c", "exit 0"],
          env: {},
          name: "short-lived",
        });
        expect((await proc.exited).code).toBe(0);
      }
      expect(warnings).toEqual([]);
    } finally {
      process.removeListener("warning", onWarning);
    }
  });
  it("can retain a natural-exit dev server explicitly until the caller stops its group", async () => {
    const service = `require('node:net').createServer(s=>s.end('alive')).listen(0,'127.0.0.1',function(){console.log(this.address().port);process.send('ready');});`;
    const proc = spawnSupervised({
      command: process.execPath,
      args: [
        "-e",
        `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(service)}],{stdio:['ignore',process.stdout,process.stderr,'ipc']});c.on('message',()=>process.exit(0));`,
      ],
      env: {},
      name: "retained-dev-server",
      killGroupOnExit: false,
    });
    owned.push(proc);
    const [port] = await once(proc.stdout, "line");
    if (!proc.signal.aborted) await once(proc.signal, "abort");
    const socket = connect({ host: "127.0.0.1", port: Number(port) });
    const [data] = await once(socket, "data");
    expect(String(data)).toBe("alive");
    socket.destroy();
    expect((await proc.stop({ graceMs: 0 })).reason).toBe("stopped");
  });
  it("drains ten megabytes from each pipe even without subscribers", async () => {
    const proc = child(
      `process.stdout.write('x'.repeat(10 * 1024 * 1024)); process.stderr.write('y'.repeat(10 * 1024 * 1024));`,
    );
    expect((await proc.exited).code).toBe(0);
  });
  it("merges explicit environment overrides with the inherited environment", async () => {
    const proc = child(
      `console.log(JSON.stringify([process.env.PROVIDER_KIT_TEST, process.env.PATH]))`,
      { PROVIDER_KIT_TEST: "override" },
    );
    const [line] = await once(proc.stdout, "line");
    expect(JSON.parse(String(line))).toEqual(["override", process.env["PATH"]]);
    await proc.exited;
  });
  it("bounds hanging probes by a timeout", async () => {
    await expect(
      probeOutput(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 50 }),
    ).rejects.toThrow("Probe timed out");
  });
  it("rejects probe output beyond the capture byte budget", async () => {
    await expect(
      probeOutput(
        process.execPath,
        ["-e", "console.log('x'.repeat(10000)); setInterval(()=>{},1000)"],
        { maxBytes: 100, timeoutMs: 5000 },
      ),
    ).rejects.toThrow("Probe output exceeded limit");
  });
});
