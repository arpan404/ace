import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect } from "vitest";
import { PublicToolError } from "@ace/mcp-server";
import { z } from "zod";
import { apply, createThreadState, type Fact } from "@ace/core";
import { createCodexTranslator } from "@ace/adapter-codex";
import { createTranslator as claude } from "@ace/adapter-claude";
import { createPiTranslator } from "@ace/adapter-pi";
import { OpenCodeTranslator } from "@ace/adapter-opencode";
import { CursorTranslator } from "@ace/adapter-cursor";
import { createAcpTranslator, genericQuirks } from "@ace/adapter-acp";
import { browserToolkit } from "@ace/browser";
import { startDaemonMcp } from "./mcp.ts";
import { measurementObserver } from "./measurement-mcp.ts";
import { ScreenManager } from "@ace/screen";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { McpScope, type ProviderKind } from "@ace/protocol";
import { startDaemon, readConfig, createDevThread } from "./index.ts";
import { measurementFrames } from "./testing/measurement-frames.ts";

async function noExtraMcp() {}

export async function toolFixture(
  provider: ProviderKind,
  options: {
    late?: boolean;
    omit?: boolean;
    large?: boolean;
    duplicate?: boolean;
    browser?: boolean;
    tool?: string;
    input?: Record<string, unknown>;
    helperEnv?: NodeJS.ProcessEnv;
    error?: boolean;
    secureConsent?: boolean;
    approvalFailure?: "denied" | "timeout" | "read_only";
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "ace-measure-step-"));
  const original = await readFile(new URL("./testing/measurement-filmstrip.jpg", import.meta.url));
  const bytes = options.large
    ? Buffer.concat([original, Buffer.alloc(60_000 - original.length)])
    : original;
  const image = join(root, "filmstrip.jpg");
  await writeFile(image, bytes);
  let next = 0;
  const screen = new ScreenManager({
    command: process.execPath,
    args: [
      new URL("../../../packages/screen/src/testing/fake-helper.ts", import.meta.url).pathname,
    ],
    env: {
      FAKE_V2: "1",
      MEASUREMENT_FILMSTRIP_FILE: image,
      MODEL_IMAGE_FILE: image,
      MODEL_FRAME_WIDTH: "120",
      MODEL_FRAME_HEIGHT: "24",
      ...options.helperEnv,
    },
    nextId: () => `screen-${++next}`,
    recordingDirectory: root,
    publishArtifact: async () => {},
  });
  let daemon = await startDaemon({
    config: readConfig({ ACE_HOME: root, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    screen,
  });
  const thread = createDevThread(
    daemon.store,
    daemon.store.createWorkspace(root, "Measurements"),
    "Measurement",
    provider,
  );
  const state = createThreadState({ threadId: thread.id, config: { provider, silenceMs: 90_000 } });
  const ids = { next: (kind: string) => `${kind}-${++next}` };
  const feedFact = (fact: Fact) =>
    daemon.store.appendEvents(thread.id, apply(state, fact, { now: Date.now(), ids }));
  feedFact({
    type: "agent.seen",
    agent: "root",
    origin: "root",
    fidelity: "full",
    native: { provider },
    cwd: root,
  });
  const agentId = daemon.store.getThread(thread.id)?.rootAgentId;
  if (!agentId) throw new Error("No root");
  const init = { threadId: thread.id, rootKey: "root" };
  const translator =
    provider === "codex"
      ? createCodexTranslator(init)
      : provider === "claude"
        ? claude(init)
        : provider === "pi"
          ? createPiTranslator(init)
          : provider === "opencode"
            ? new OpenCodeTranslator(init)
            : provider === "cursor"
              ? new CursorTranslator(init)
              : createAcpTranslator(
                  { ...init, identity: { generation: "fake", cursor: 0 } },
                  genericQuirks,
                );
  await screen.enable(true);
  await screen.approve("dev.ace.test", true);
  const session = await screen.start({ kind: "window", bundleId: "dev.ace.test", windowId: 1 });
  screen.configureAccess({
    enabled: () => true,
    enable() {},
    list: () => [{ bundleId: "dev.ace.test", scope: "always", grantedAt: 0 }],
    allows: () => true,
    approve() {},
    async request() {
      if (options.approvalFailure) throw new PublicToolError(options.approvalFailure);
      return;
    },
    async foreground() {},
    audit() {},
  });
  if (options.tool?.startsWith("screen_") && options.tool !== "screen_request_app")
    screen.controller(session.sessionId, "agent", JSON.stringify([thread.id, agentId]));
  if (options.secureConsent) screen.secureInput(session.sessionId, true);
  let mcp = daemon.mcp;
  let closeMcp = noExtraMcp;
  if (options.browser) {
    // The browser I/O port is fake; its production toolkit and MCP transport execute normally.
    const observations = measurementObserver({
      store: daemon.store,
      now: Date.now,
      id: () => `browser-evidence-${++next}`,
      context: () => daemon.context,
    });
    mcp = await startDaemonMcp(
      daemon.store,
      [
        browserToolkit({
          async execute() {
            return {
              source: "browser-trace",
              target: { kind: "browser-tab", threadId: thread.id },
              refreshHz: 60,
              windowMs: 2000,
              frames: 100,
              hitches: [],
              verdict: "smooth",
              confidence: "high",
              notes: [],
              filmstrip: { type: "image", mimeType: "image/jpeg", data: bytes.toString("base64") },
            };
          },
          async screenshot() {
            return bytes;
          },
        }),
      ],
      undefined,
      observations,
    );
    closeMcp = async () => {
      await mcp.close();
      observations.close();
    };
  }
  const lifetime = new AbortController();
  const lease = mcp.openSession(
    McpScope.parse({
      sessionId: "offline",
      threadId: thread.id,
      agentId,
      capabilities: options.browser ? ["browser"] : ["screen"],
    }),
    lifetime.signal,
  );
  const tool =
    options.tool ??
    (options.browser ? "ace_browser_measure_interaction" : "screen_measure_interaction");
  const args = options.browser
    ? { observeMs: 2000 }
    : options.tool &&
        (!options.tool.startsWith("screen_") ||
          ["screen_open_app", "screen_request_app"].includes(options.tool))
      ? (options.input ?? {})
      : { sessionId: session.sessionId, ...(options.input ?? { observeMs: 2000 }) };
  const frames = measurementFrames(provider, args, tool);
  if (options.duplicate)
    frames.before.push(
      ...measurementFrames(provider, args)
        .before.slice(-1)
        .map((frame) =>
          Object.assign({}, frame, {
            data: JSON.parse(
              JSON.stringify(frame.data)
                .replaceAll('"measure"', '"other"')
                .replaceAll('"id":"message"', '"id":"other-message"'),
            ),
          }),
        ),
    );
  const cli = spawnRawSupervised({
    command: process.execPath,
    args: [new URL("./testing/measurement-provider.ts", import.meta.url).pathname],
    cwd: root,
    env: {},
    name: `fake-${provider}-measurement`,
  });
  cli.stdin.write(
    JSON.stringify({
      url: mcp.url,
      bearer: lease.bearer,
      tool,
      args,
      ...frames,
      late: options.late ?? false,
      omit: options.omit ?? false,
    }) + "\n",
  );
  let seq = 0;
  let result: unknown;
  try {
    for await (const line of createInterface({ input: cli.stdout })) {
      const message = z
        .object({
          kind: z.string(),
          frame: z
            .object({
              channel: z.string(),
              dir: z.enum(["recv", "send", "note"]),
              data: z.unknown(),
            })
            .optional(),
          result: z.unknown().optional(),
        })
        .parse(JSON.parse(line));
      if (message.frame) {
        const at = Date.now();
        for (const fact of translator.translate({ ...message.frame, seq: ++seq, t: at }, at))
          feedFact(fact);
      }
      if (message.kind === "result") result = message.result;
      if (message.kind === "done") break;
      cli.stdin.write("committed\n");
    }
    expect(await cli.exited).toMatchObject({ code: 0 });
    if (options.error) expect(result, JSON.stringify(result)).toMatchObject({ isError: true });
    else expect(result, JSON.stringify(result)).not.toMatchObject({ isError: true });
    return {
      get daemon() {
        return daemon;
      },
      async restart() {
        lease.end();
        await closeMcp();
        await daemon.close();
        daemon = await startDaemon({
          config: readConfig({ ACE_HOME: root, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
        });
      },
      thread,
      bytes,
      result,
      root,
      async close() {
        lease.end();
        await closeMcp();
        await daemon.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await cli.stop();
    lease.end();
    await closeMcp();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
