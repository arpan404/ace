import * as sdk from "@cursor/sdk";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { apply, createThreadState } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import {
  HostRuntime,
  CursorTranslator,
  CursorLimitsSchema,
  openCursorSession,
  CursorEnvelopeSchema,
  type RuntimeSdkBoundary,
} from "./index.ts";

test.each(
  (["setup", "send", "stream", "result"] as const).flatMap((stage) =>
    (
      [
        "ordinary",
        "environment collision",
        "escaped budget",
        "input budget",
        "lease boundary",
      ] as const
    ).map((scenario) => ({
      stage,
      scenario,
    })),
  ),
)(
  "Cursor $stage failures retain terminal reporting with $scenario prose",
  async ({ stage, scenario }) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "cursor-error-")));
    const secret = "sk-" + "a".repeat(40);
    const reason =
      "Local SDK sandboxing was requested, but sandboxing is not supported in this environment.";
    const failure = new sdk.ConfigurationError(
      scenario === "escaped budget"
        ? "\0".repeat(65536)
        : scenario === "lease boundary"
          ? `${reason} ${"x".repeat(3980)} ${"d".repeat(64)}`
          : `${reason} Authorization: Bearer ${secret} ${"x".repeat(scenario === "input budget" ? 262144 : 12000)}`,
    );
    const threadId = ThreadId.parse("error-test");
    const state = createThreadState({ threadId, config: { provider: "cursor", silenceMs: 90000 } });
    const translator = new CursorTranslator({ threadId, rootKey: "root" });
    let seq = 0,
      id = 0;
    const terminal = Promise.withResolvers<void>();
    const agent = {
      agentId: "created-agent",
      async [Symbol.asyncDispose]() {},
      async send() {
        if (stage === "send") throw failure;
        return {
          id: "created-run",
          async *stream() {
            if (stage === "stream") throw failure;
            yield { type: "system" as const, agent_id: "created-agent", run_id: "created-run" };
          },
          async wait() {
            return {
              id: "created-run",
              status: "error" as const,
              error: { message: failure.message },
            };
          },
          async cancel() {},
        };
      },
    };
    const boundary: RuntimeSdkBoundary = {
      ...sdk,
      Cursor: {
        auth: {
          async status() {
            return { status: "logged-in", backendUrl: "https://synthetic.invalid" };
          },
        },
      },
      Agent: {
        async create() {
          if (stage === "setup") throw failure;
          return agent;
        },
        async resume() {
          return agent;
        },
        async cancelRun() {},
      },
    };
    const host = new HostRuntime(
      boundary,
      async (envelope) => {
        for (const fact of translator.translate(
          { seq: ++seq, t: seq, dir: "recv", channel: "sdk", data: envelope },
          seq,
        ))
          apply(state, fact, { now: seq, ids: { next: (kind) => `${kind}-${++id}` } });
        if (envelope.kind === "error" || envelope.kind === "result") terminal.resolve();
      },
      () => home,
      scenario === "environment collision" ? { USER: "text" } : {},
    );
    try {
      const opening = host.open({
        threadId,
        cwd: home,
        generation: "host",
        policy: "full-access",
        ...(scenario === "lease boundary"
          ? { mcp: { url: "http://127.0.0.1:1/mcp", bearer: "d".repeat(64) } }
          : {}),
        limits: CursorLimitsSchema.parse({}),
      });
      if (stage === "setup") await expect(opening).rejects.toThrow();
      else {
        await opening;
        const sending = host.send({
          operationId: "op",
          segment: 0,
          input: [{ type: "text", text: "synthetic" }],
        });
        if (stage === "send") await expect(sending).rejects.toThrow();
        else await sending;
      }
      await terminal.promise;
      const visible = Object.values(state.items)
        .filter((item) => item.type === "notice" && item.level === "error")
        .map((item) => (item.type === "notice" ? item.text : ""))
        .join("\n");
      expect(visible).toContain(scenario === "escaped budget" ? "no printable details" : reason);
      expect(visible).not.toContain("\0");
      expect(visible).not.toContain(secret);
      expect(visible).not.toContain("d".repeat(8));
      expect(visible.length).toBeLessThan(5000);
      expect(visible).not.toContain("did not establish a run identity");
    } finally {
      await host.close().catch(() => {});
      await rm(home, { recursive: true, force: true });
    }
  },
);

test.each(["raw", "wire"] as const)(
  "a crashed Cursor %s host exposes redacted stderr instead of only a generic exit",
  async (transport) => {
    const home = await mkdtemp(join(tmpdir(), "cursor-stderr-"));
    const entry = join(home, "host.mjs");
    await writeFile(
      entry,
      transport === "wire"
        ? `import {hostWire} from ${JSON.stringify(new URL("./host-wire.ts", import.meta.url).href)};
hostWire(async method=>{if(method==='open')return {agentId:'native'}; if(method==='send'){process.stderr.write('SDK helper dependency missing; opaque-');process.stderr.write('sdk-secret\\n',()=>process.stderr.end(()=>process.exit(1)));return new Promise(()=>{});}},()=>process.exit(0));`
        : `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='open') console.log(JSON.stringify({id:m.id,result:{agentId:'native'}}));else if(m.method==='send'){process.stderr.write('SDK helper dependency missing; Bearer sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n',()=>process.exit(1));}});`,
    );
    const exited = Promise.withResolvers<{ deliberate: boolean; message?: string }>();
    const exitFrame = Promise.withResolvers<unknown>();
    try {
      const session = await openCursorSession(
        {
          threadId: ThreadId.parse("stderr"),
          cwd: home,
          signal: new AbortController().signal,
          onFrame(frame) {
            const envelope = CursorEnvelopeSchema.parse(frame.data);
            if (envelope.kind === "host-exit") exitFrame.resolve(envelope.body);
          },
          onExit: exited.resolve,
        },
        {
          instanceId: "private",
          env: { HOME: home, USER: "text", CURSOR_API_KEY: "opaque-sdk-secret" },
          entry,
        },
      );
      await expect(session.send([{ type: "text", text: "synthetic" }], "queue")).rejects.toThrow(
        "SDK helper dependency missing",
      );
      expect((await exited.promise).message).toBe(
        "Cursor stopped unexpectedly. Unfinished work needs your attention.",
      );
      const evidence = JSON.stringify(await exitFrame.promise);
      expect(evidence).toContain("SDK helper dependency missing");
      expect(evidence).not.toContain("sk-aaaaaaaa");
      expect(evidence).not.toContain("opaque-");
      expect(evidence).not.toContain("sdk-secret");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
