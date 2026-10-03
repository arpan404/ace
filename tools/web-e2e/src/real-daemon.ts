import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScriptedAdapter, type ScriptedStep } from "@ace/adapter-testkit";
import type { Fact } from "@ace/core";
import { AdapterRegistry, readConfig, startDaemon } from "@ace/daemon";
import type { Frame, SessionContext } from "@ace/engine-api";
import { Capabilities, ServerMessage, type ContentPart, type ProviderKind } from "@ace/protocol";
import {
  daemonHome,
  daemonPort,
  scriptedReply,
  seededTitle,
  workspaceName,
} from "./real-daemon-config.ts";

/**
 * A real ace daemon (apps/daemon) for the e2e smoke test, with scripted providers from
 * @ace/adapter-testkit registered in place of discovery, so no provider CLI is ever started.
 * Each message a thread receives is answered with `scriptedReply` and the turn ends.
 */
const replies = 20;

const message = (item: string, role: "user" | "assistant", text: string): Fact => ({
  type: "item.upsert",
  agent: "root",
  item,
  draft: { type: "message", role, complete: true, parts: [{ type: "text", text }] },
});

/**
 * The testkit's scripted adapter, with each message answered by one turn: the person's text
 * (providers echo user input; the engine does not), the scripted reply, then the turn ends.
 */
function scriptedProvider(provider: ProviderKind) {
  const bundles = new Map<string, Fact[]>();
  let seq = 0;
  const frame = (...facts: Fact[]): Frame => {
    const channel = `facts-${++seq}`;
    bundles.set(channel, facts);
    return { seq, t: seq, dir: "recv", channel, data: { scripted: true } };
  };
  const adapter = createScriptedAdapter({
    provider,
    nativeSessionId: `scripted-${provider}`,
    capabilities: Capabilities.parse({
      steer: true,
      interruptCascades: false,
      resume: true,
      fork: false,
      subagentTranscripts: true,
      backgroundTaskControl: true,
      backgroundVisibility: "full",
      planMode: false,
      tokenUsage: false,
      imageInput: true,
      rewindFiles: false,
    }),
    createTranslator: () => ({
      translate: (incoming) => structuredClone(bundles.get(incoming.channel) ?? []),
      tick: () => [],
    }),
    steps: Array.from({ length: replies }, (): ScriptedStep => ({ on: "send" })),
  });
  return {
    ...adapter,
    async openSession(ctx: SessionContext) {
      const session = await adapter.openSession(ctx);
      return {
        ...session,
        async send(input: ContentPart[], delivery: "steer" | "queue") {
          await session.send(input, delivery);
          const text = input.flatMap((part) => (part.type === "text" ? [part.text] : []));
          const turn = ++seq;
          ctx.onFrame(
            frame(
              { type: "turn.started", agent: "root", trigger: "user" },
              message(`ask-${turn}`, "user", text.join("\n")),
              message(`reply-${turn}`, "assistant", scriptedReply),
              { type: "turn.ended", agent: "root", outcome: "completed" },
            ),
          );
        },
      };
    },
  };
}

rmSync(daemonHome, { recursive: true, force: true });
const project = join(daemonHome, "projects", workspaceName);
mkdirSync(project, { recursive: true });
writeFileSync(join(project, "README.md"), "# e2e project\n");

const registry = new AdapterRegistry();
for (const provider of ["claude", "codex"] as const)
  registry.register(scriptedProvider(provider), {
    installed: true,
    auth: "logged_in",
    loginHint: "scripted",
  });

const daemon = await startDaemon({
  config: { ...readConfig({}), dataDir: daemonHome, port: daemonPort, logLevel: "warn" },
  engine: { registry },
});
const workspace = daemon.store.createWorkspace(project, workspaceName);
await seedThread(daemon.url, readFileSync(daemon.tokenPath, "utf8").trim(), workspace);
process.stdout.write(`e2e daemon ready on ${daemon.url}\n`);

const stop = () => void daemon.close().finally(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

/** One thread created the way any client creates one, so Home has something to open. */
async function seedThread(url: string, token: string, workspaceId: string): Promise<void> {
  const deviceId = "e2e-seed";
  const socket = new WebSocket(url);
  const result = new Promise<void>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      const parsed = ServerMessage.safeParse(JSON.parse(String(event.data)));
      if (!parsed.success) return;
      const reply = parsed.data;
      if (reply.type === "commandResult")
        return reply.ok ? resolve() : reject(new Error(`thread.create failed: ${reply.error}`));
      if (reply.type === "error") reject(new Error(String(event.data)));
    });
    socket.addEventListener("error", () => reject(new Error("Seed socket failed")));
  });
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, deviceId, token }));
  socket.send(
    JSON.stringify({
      type: "command",
      command: {
        id: randomUUID(),
        deviceId,
        payload: {
          type: "thread.create",
          workspaceId,
          provider: "claude",
          title: seededTitle,
          input: [{ type: "text", text: "Say hello from the scripted provider." }],
        },
      },
    }),
  );
  await result;
  socket.close();
}
