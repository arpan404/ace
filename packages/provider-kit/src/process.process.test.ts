import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { PROCESS_TEST_TIMEOUT } from "./testing/cli.ts";
import {
  probeOutput,
  spawnSupervised,
  spawnRawSupervised,
  type SupervisedProcess,
} from "./process.ts";

const owned: SupervisedProcess[] = [];
const noop = () => {};
function cleanupGroup(pgid: number) {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && !(process.platform === "darwin" && code === "EPERM")) throw error;
  }
}
async function waitForGroupExit(pgid: number) {
  const deadline = performance.now() + PROCESS_TEST_TIMEOUT;
  while (performance.now() < deadline) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH" || (process.platform === "darwin" && code === "EPERM")) return;
      throw error;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Owned process group still existed after the cleanup deadline");
}
async function expectRefused(port: number) {
  const deadline = performance.now() + PROCESS_TEST_TIMEOUT;
  while (performance.now() < deadline) {
    const socket = connect({ host: "127.0.0.1", port });
    const result = await new Promise<string>((resolve) => {
      socket.once("connect", () => {
        socket.resume();
        socket.end();
        socket.once("close", () => resolve("still-serving"));
      });
      socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "unknown"));
    });
    if (result === "ECONNREFUSED") return;
    expect(["still-serving", "ECONNRESET"]).toContain(result);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Owned service still accepted connections after group cleanup");
}
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
    expect(await proc.stop({ graceMs: PROCESS_TEST_TIMEOUT })).toEqual({
      code: 0,
      signal: null,
      reason: "stopped",
    });
  });
  it("lets a child finish asynchronous transcript work during the TERM grace period", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ace-grace-"));
    const marker = join(directory, "flushed");
    const proc = child(
      `process.on('SIGTERM',()=>setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},'transcript-flushed');process.exit(0);},100));console.log('ready');setInterval(()=>{},1000);`,
    );
    try {
      await once(proc.stdout, "line");
      expect(await proc.stop({ graceMs: PROCESS_TEST_TIMEOUT })).toEqual({
        code: 0,
        signal: null,
        reason: "stopped",
      });
      expect(await readFile(marker, "utf8")).toBe("transcript-flushed");
    } finally {
      await proc.stop({ graceMs: 0 });
      await rm(directory, { recursive: true, force: true });
    }
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
      const service = `const server=require('node:net').createServer().listen(0, '127.0.0.1', function(){console.log(JSON.stringify({port:this.address().port,pgid:process.pid}));});process.on('SIGTERM',()=>{console.log('transcript-flushed');server.close(()=>process.exit(0));});`;
      const script = `import {spawnSupervised,installShutdownHandlers} from ${JSON.stringify(moduleUrl)};
      ${termination === "exit" ? "" : `installShutdownHandlers({graceMs:${PROCESS_TEST_TIMEOUT}});`}
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
      const [line] = await once(lines, "line");
      const address: { port: number; pgid: number } = JSON.parse(String(line));
      expect(await closed).toEqual(termination === "exit" ? [0, null] : [null, termination]);
      if (termination !== "exit") expect(output).toContain("transcript-flushed");
      await waitForGroupExit(address.pgid);
      await expectRefused(address.port);
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
  it("stops a retained descendant after natural exit has closed every pipe", async () => {
    const service = `require('node:net').createServer(s=>s.end('alive')).listen(0,'127.0.0.1',function(){process.send(this.address().port);});`;
    const proc = spawnSupervised({
      command: process.execPath,
      args: [
        "-e",
        `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(service)}],{stdio:['ignore','ignore','ignore','ipc']});c.on('message',port=>{console.log(JSON.stringify({port,pgid:process.pid}));process.exit(0);});`,
      ],
      env: {},
      name: "retained-closed-pipes",
      killGroupOnExit: false,
    });
    owned.push(proc);
    const [line] = await once(proc.stdout, "line");
    const address: { port: number; pgid: number } = JSON.parse(String(line));
    try {
      expect((await proc.exited).code).toBe(0);
      const socket = connect({ host: "127.0.0.1", port: address.port });
      const [data] = await once(socket, "data");
      expect(String(data)).toBe("alive");
      socket.destroy();
      await proc.stop({ graceMs: 0 });
      await waitForGroupExit(address.pgid);
      await expectRefused(address.port);
    } finally {
      // Clean up the group spawned by this test even when the regression is present.
      cleanupGroup(address.pgid);
    }
  });
  it("owner exit cleans a retained descendant even after every child pipe has closed", async () => {
    const moduleUrl = new URL("./process.ts", import.meta.url).href;
    const service = `require('node:net').createServer(s=>s.end('alive')).listen(0,'127.0.0.1',function(){process.send(this.address().port);});`;
    const leader = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(service)}],{stdio:['ignore','ignore','ignore','ipc']});c.on('message',port=>{console.log(JSON.stringify({port,pgid:process.pid}));process.exit(0);});`;
    const script = `import {spawnSupervised} from ${JSON.stringify(moduleUrl)};import {connect} from 'node:net';
      const proc=spawnSupervised({command:process.execPath,args:['-e',${JSON.stringify(leader)}],env:{},name:'retained-service',killGroupOnExit:false});
      let address;proc.stdout.on('line',line=>{address=JSON.parse(line);console.log(line);});
      await proc.exited;const socket=connect({host:'127.0.0.1',port:address.port});socket.on('data',data=>{console.log('retained-'+data);process.exit(0);});socket.on('error',()=>process.exit(2));`;
    const owner = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = once(owner, "close");
    const lines = createInterface({ input: owner.stdout });
    const output: string[] = [];
    lines.on("line", (line) => output.push(line));
    const [line] = await once(lines, "line");
    const address: { port: number; pgid: number } = JSON.parse(String(line));
    try {
      expect(await closed).toEqual([0, null]);
      expect(output).toContain("retained-alive");
      await waitForGroupExit(address.pgid);
      await expectRefused(address.port);
    } finally {
      owner.kill("SIGKILL");
      cleanupGroup(address.pgid);
    }
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
  it("advancing the probe deadline stops a hanging child", async () => {
    let deadline = noop;
    const result = probeOutput(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      schedule(callback) {
        deadline = callback;
        return () => {};
      },
    });
    const rejected = expect(result).rejects.toThrow("Probe timed out");
    deadline();
    await rejected;
  });
  it("rejects probe output beyond the capture byte budget", async () => {
    await expect(
      probeOutput(
        process.execPath,
        ["-e", "console.log('x'.repeat(10000)); setInterval(()=>{},1000)"],
        { maxBytes: 100, timeoutMs: PROCESS_TEST_TIMEOUT },
      ),
    ).rejects.toThrow("Probe output exceeded limit");
  });
});

it("an aborted read-only probe stops its real child and rejects without waiting for output", async () => {
  const controller = new AbortController();
  const result = probeOutput(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    signal: controller.signal,
  });
  controller.abort();
  await expect(result).rejects.toThrow("Probe aborted");
});

it("newline-free probe output is stopped by its byte budget before a line can accumulate", async () => {
  let exited: Promise<unknown> = Promise.resolve();
  const result = probeOutput(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000)"],
    {
      maxBytes: 100,
      schedule: () => () => {},
      spawn(options) {
        const proc = spawnRawSupervised(options);
        exited = proc.exited;
        return proc;
      },
    },
  );
  await expect(result).rejects.toThrow("Probe output exceeded limit");
  expect(await exited).toMatchObject({ reason: "output-limit" });
});
