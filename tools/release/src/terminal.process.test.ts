import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { Store, createDevThread } from "@ace/daemon";
import { ServerMessage } from "@ace/protocol";
import { bundleDaemon } from "@ace/release";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test(
  "the bundled daemon opens a terminal in a thread's checkout and runs a command there",
  { timeout: 90_000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ace-bundle-terminal-")));
    roots.push(root);
    const bundle = join(root, "bundle");
    const project = join(root, "project");
    const data = join(root, "data");
    await mkdir(bundle);
    await mkdir(project);
    await mkdir(data);
    const publicKey = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    await bundleDaemon(resolve(import.meta.dirname, "../../.."), bundle, publicKey);
    const store = new Store(join(data, "events.sqlite"));
    let threadId: string;
    try {
      threadId = createDevThread(store, store.createWorkspace(project, "Terminal fixture")).id;
    } finally {
      store.close();
    }

    // Only the bundle directory: nothing from the checkout is reachable from the daemon.
    const child = spawn(process.execPath, [join(bundle, "ace.mjs"), "start"], {
      cwd: bundle,
      env: {
        HOME: root,
        PATH: "/usr/bin:/bin",
        SHELL: "/bin/sh",
        ACE_HOME: data,
        ACE_PORT: "0",
        ACE_LISTEN: "local",
        ACE_MODEL_INSTANCES: "[]",
        ACE_HISTORY_INSTANCES: "[]",
        ACE_DEV: "0",
        ACE_MAINTENANCE: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-65536);
    });
    try {
      await new Promise<void>((ready, reject) => {
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-65536);
          if (output.includes("Token file:")) ready();
        });
        child.once("error", reject);
        child.once("close", () => reject(new Error(errors)));
      });
      const endpoint = await readFile(join(data, "daemon-endpoint"), "utf8");
      const token = await readFile(join(data, "daemon-token"), "utf8");
      const socket = new WebSocket(endpoint.replace("http:", "ws:"));
      const send = (message: unknown) => socket.send(JSON.stringify(message));
      try {
        const screen = await new Promise<string>((done, reject) => {
          let text = "";
          socket.addEventListener("open", () =>
            send({ type: "hello", protocolVersion: 1, deviceId: "terminal-host", token }),
          );
          socket.addEventListener("error", () => reject(new Error("WebSocket failed")));
          socket.addEventListener("close", () => reject(new Error("WebSocket closed")));
          socket.addEventListener("message", (event) => {
            const frame = ServerMessage.parse(JSON.parse(String(event.data)));
            if (frame.type === "welcome")
              send({
                type: "terminal.request",
                requestId: "open",
                operation: { op: "open", threadId, name: "Smoke" },
              });
            else if (frame.type === "terminal.result" && frame.requestId === "open") {
              if (!frame.ok || !frame.terminal)
                return reject(new Error(`Terminal did not open: ${frame.error ?? "no terminal"}`));
              const terminalId = frame.terminal.id;
              send({
                type: "terminal.request",
                requestId: "subscribe",
                operation: { op: "subscribe", threadId, terminalId, subscriptionId: "screen" },
              });
              send({
                type: "terminal.request",
                requestId: "write",
                operation: { op: "write", threadId, terminalId, data: "pwd; exit\r" },
              });
            } else if (frame.type === "terminal.output") {
              send({ type: "terminal.credit", subscriptionId: frame.subscriptionId });
              if (frame.event.type === "data") text += frame.event.data;
              if (frame.event.type === "exit") done(text);
            } else if (frame.type === "terminal.result" && !frame.ok)
              reject(new Error(`${frame.requestId} failed: ${frame.error ?? "unknown"}`));
          });
        });
        expect(screen).toContain(project);
      } finally {
        socket.close();
      }
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      expect((await exit)[0]).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGKILL");
        await exit;
      }
    }
  },
);
