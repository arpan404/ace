import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { WebSocket } from "ws";
import { ServerMessage } from "@ace/protocol";

/**
 * Provider CLIs that answer `--version` and their login check after `delayMs`, as installed
 * ones take a few hundred milliseconds to start. Each call is logged, so the bench counts the
 * probes a start runs. Never the real CLIs: their checks spend nothing, but sessions would.
 */
export async function fakeProviderClis(root: string, delayMs: number) {
  const bin = join(root, "bin");
  const calls = join(root, "calls.log");
  await mkdir(bin, { recursive: true });
  await writeFile(calls, "");
  const answers: Record<string, Record<string, string>> = {
    claude: {
      "--version": "2.1.300 (Claude Code)",
      "auth status": JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
    },
    codex: { "--version": "codex-cli 0.170.0", "login status": "Logged in using ChatGPT" },
    opencode: { "--version": "2.0.30", "auth list --standalone --format json": "[]" },
    pi: { "--version": "0.90.0" },
  };
  const seconds = (delayMs / 1000).toFixed(3);
  for (const [name, replies] of Object.entries(answers)) {
    const cases = Object.entries(replies)
      .map(([args, reply]) => `  "${args}") printf '%s\\n' '${reply}' ;;`)
      .join("\n");
    await writeFile(
      join(bin, name),
      `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> '${calls}'\n/bin/sleep ${seconds}\ncase "$*" in\n${cases}\n  *) exit 1 ;;\nesac\n`,
    );
    await chmod(join(bin, name), 0o755);
  }
  return {
    bin,
    /** Forgets the calls so far, so a count covers one start. */
    async reset(): Promise<void> {
      await writeFile(calls, "");
    },
    /** Every CLI call so far, as `name args`. */
    async calls(): Promise<string[]> {
      return (await readFile(calls, "utf8")).split("\n").filter(Boolean);
    },
  };
}

/**
 * A client that connects as soon as the endpoint exists, as the desktop does after a restart,
 * and times its welcome and its first thread list (the sidebar) from `started`.
 */
export async function firstClient(endpoint: string, token: string, started: number) {
  const socket = new WebSocket(endpoint.replace("http:", "ws:"));
  await once(socket, "open");
  const welcomed = Promise.withResolvers<number>();
  const listed = Promise.withResolvers<number>();
  let starting = false;
  socket.on("message", (bytes: Buffer) => {
    const message = ServerMessage.parse(JSON.parse(bytes.toString()));
    if (message.type === "starting") starting = true;
    if (message.type === "welcome") {
      welcomed.resolve(performance.now() - started);
      socket.send(
        JSON.stringify({
          type: "subscribe",
          subscriptionId: "sidebar",
          scope: { kind: "threads", window: { limit: 20 } },
        }),
      );
    }
    if (message.type === "snapshot" || (message.type === "snapshot.part" && message.done))
      listed.resolve(performance.now() - started);
    if (message.type === "error") {
      const failure = new Error(JSON.stringify(message));
      welcomed.reject(failure);
      listed.reject(failure);
    }
  });
  socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, deviceId: "perf-first", token }));
  const welcomeMs = await welcomed.promise;
  const threadsListMs = await listed.promise;
  socket.close();
  await once(socket, "close");
  return { welcomeMs, threadsListMs, sawStarting: starting };
}
