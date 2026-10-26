import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import type { Frame, ProviderSession } from "@ace/engine-api";
import { InputRejected } from "@ace/engine-api";
import { ThreadId } from "@ace/protocol";
import { createAcpAdapter, openAcpSession } from "./index.ts";
import { antigravityQuirks } from "./quirks/antigravity.ts";
import { genericQuirks } from "./quirks/generic.ts";
import { extensionQuirks } from "./testing/extension-quirks.ts";
import { ended, stubbornTree, writeCmdShim } from "@ace/provider-kit/testing/cmd-shim";
import { interactionKey } from "./interactions.ts";
import { nativeAgentKey } from "./keys.ts";
import { object } from "./data.ts";
import type { AcpQuirks } from "./quirks/types.ts";

// npm installs ACP agents on Windows as `.cmd` shims, so every case launches the fake through
// cmd.exe. Windows has no SIGTERM for these children: stops close stdin, then stop the tree.
const windows = process.platform === "win32";
const fake = fileURLToPath(new URL("./testing/acp-server.ts", import.meta.url));
const negotiation = fileURLToPath(new URL("./testing/negotiation-server.ts", import.meta.url));
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup(
  options: {
    quirks?: AcpQuirks;
    resume?: boolean;
    script?: string;
    env?: Record<string, string>;
    preload?: (dir: string) => Promise<string>;
  } = {},
) {
  const quirks = options.quirks ?? extensionQuirks;
  const home = await mkdtemp(join(tmpdir(), "ace-acp-shim-"));
  dirs.push(home);
  const shim = await writeCmdShim(
    home,
    "acp-agent",
    options.script ?? fake,
    await options.preload?.(home),
  );
  const frames: Frame[] = [];
  const watchers = new Set<() => void>();
  const controller = new AbortController();
  const exited = Promise.withResolvers<{ deliberate: boolean }>();
  const ctx = {
    threadId: ThreadId.parse("session-test"),
    cwd: home,
    env: { ...options.env },
    // The negotiation fake offers its own models; the session fake offers "test-model".
    ...(options.script ? {} : { model: "test-model" }),
    signal: controller.signal,
    ...(options.resume ? { resume: { nativeSessionId: "native-root" } } : {}),
    onFrame(frame: Frame) {
      frames.push(frame);
      for (const watcher of watchers) watcher();
    },
    onExit: exited.resolve,
  };
  const session: ProviderSession =
    quirks === genericQuirks
      ? await createAcpAdapter(quirks, { command: shim, args: [] }).openSession(ctx)
      : await openAcpSession(ctx, quirks, {
          command: shim,
          args: [],
          env: ctx.env,
          version: "1.2.1",
        });
  const wait = (predicate: (f: Frame) => boolean) =>
    new Promise<Frame>((resolve) => {
      const check = () => {
        const found = frames.find(predicate);
        if (!found) return;
        watchers.delete(check);
        resolve(found);
      };
      watchers.add(check);
      check();
    });
  return { home, session, frames, exited: exited.promise, wait };
}
const input = (text: string) => [{ type: "text" as const, text }];
const method = (f: Frame, name: string) => object(f.data)["method"] === name;
const sent = (frames: Frame[], name: string) =>
  frames.filter((f) => f.dir === "send" && method(f, name));

test.runIf(windows)(
  "Windows ACP agent behind a .cmd shim loads its native session and selects the model before input",
  async () => {
    const h = await setup({ resume: true });
    try {
      expect(h.session.nativeSessionId).toBe("native-root");
      await h.session.send(input("ok"), "queue");
      expect(
        h.frames
          .filter((f) => f.dir === "send")
          .map((f) => object(f.data)["method"])
          .filter(Boolean)
          .slice(0, 3),
      ).toEqual(["initialize", "session/load", "session/set_config_option"]);
      expect(sent(h.frames, "session/prompt")).toHaveLength(1);
    } finally {
      await h.session.close("idle");
    }
  },
);

test.runIf(windows)(
  "Windows ACP interrupt cancels pending interactions and sends session/cancel down the child tree",
  async () => {
    const h = await setup();
    try {
      const active = h.session.send(input("hold"), "queue");
      await h.wait((f) => method(f, "cursor/create_plan"));
      await h.session.interrupt({ cascade: true });
      await active;
      expect(object((await h.wait((f) => method(f, "test/answer"))).data)["params"]).toEqual({
        outcome: { outcome: "cancelled" },
      });
      await h.session.send(input("child"), "queue");
      await h.session.interrupt({
        agent: nativeAgentKey("session-test", "native-child"),
        cascade: false,
      });
      expect(
        sent(h.frames, "session/cancel").map((f) => object(object(f.data)["params"])["sessionId"]),
      ).toContain("native-child");
    } finally {
      await h.session.close("user");
    }
  },
);

test.runIf(windows)(
  "Windows Antigravity answers a permission request with the chosen option ID",
  async () => {
    const h = await setup({ quirks: antigravityQuirks });
    try {
      const active = h.session.send(input("permission"), "queue");
      await h.wait((f) => method(f, "session/request_permission"));
      await h.session.resolve(interactionKey(100), {
        kind: "question",
        answers: { interaction_choice: ["a"] },
      });
      await active;
      expect(object((await h.wait((f) => method(f, "test/answer"))).data)["params"]).toEqual({
        outcome: { outcome: "selected", optionId: "a" },
      });
    } finally {
      await h.session.close("user");
    }
  },
);

test.runIf(windows)(
  "Windows ACP reports an agent that dies on its own as not deliberate and refuses later input",
  async () => {
    const h = await setup({ quirks: genericQuirks });
    try {
      const died = await h.session.send(input("die"), "queue").catch((error: unknown) => error);
      expect(died).toBeInstanceOf(Error);
      expect((await h.exited).deliberate).toBe(false);
      await expect(h.session.send(input("next"), "queue")).rejects.toBeInstanceOf(InputRejected);
    } finally {
      await h.session.close("shutdown");
    }
  },
);

test.runIf(windows)(
  "Windows ACP close drains the agent's final shutdown facts after closing its stdin",
  async () => {
    const h = await setup({
      quirks: genericQuirks,
      script: negotiation,
      env: { ACE_SYNTHETIC_ACP: "{}" },
    });
    await h.session.send(input("synthetic"), "queue");
    await h.session.close("user");
    expect((await h.exited).deliberate).toBe(true);
    expect(JSON.stringify(h.frames)).toContain("future_shutdown");
  },
);

test.runIf(windows)(
  "Windows ACP close ends an agent that ignores EOF and polite stops, with its grandchild",
  async () => {
    const pids = join(await mkdtemp(join(tmpdir(), "ace-acp-tree-")), "pids.json");
    dirs.push(join(pids, ".."));
    const h = await setup({ env: { ACE_TEST_TREE_PIDS: pids }, preload: stubbornTree });
    const tree = object(JSON.parse(await readFile(pids, "utf8")));
    await h.session.send(input("ok"), "queue");
    await h.session.close("user");
    expect((await h.exited).deliberate).toBe(true);
    expect(await ended(Number(tree["agent"]))).toBe(true);
    expect(await ended(Number(tree["child"]))).toBe(true);
  },
);
