import * as sdk from "@cursor/sdk";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import {
  openCursorSession,
  HostRuntime,
  CursorLimitsSchema,
  type RuntimeSdkBoundary,
} from "./index.ts";

test.each(["restricted", "full-access"] as const)(
  "Cursor %s launches with the native policy even when classifier availability is unknown",
  async (policy) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "cursor-permission-")));
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
        async create(options) {
          const guarded =
            options.local?.sandboxOptions?.enabled === true &&
            options.local?.autoReview === true &&
            options.local?.subagentInherit !== undefined;
          const unrestricted =
            options.local?.sandboxOptions?.enabled === false && options.local?.autoReview === false;
          if (!guarded && !unrestricted) throw new Error("Native policy was omitted");
          return {
            agentId: guarded ? "restricted-native-agent" : "full-native-agent",
            async send() {
              throw new Error("No provider prompts");
            },
            async [Symbol.asyncDispose]() {},
          };
        },
        async resume() {
          throw new Error("Fresh session");
        },
        async cancelRun() {
          throw new Error("No live run");
        },
      },
    };
    const host = new HostRuntime(
      boundary,
      async () => {},
      () => home,
    );
    try {
      expect(
        await host.open({
          threadId: "permission",
          cwd: home,
          generation: "host",
          policy,
          autoReviewAvailable: false,
          limits: CursorLimitsSchema.parse({}),
        }),
      ).toEqual({
        agentId: policy === "restricted" ? "restricted-native-agent" : "full-native-agent",
      });
    } finally {
      await host.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("an explicit Cursor auto-review mode overrides legacy full-access policy at the supervised host boundary", async () => {
  const home = await mkdtemp(join(tmpdir(), "cursor-mode-"));
  const entry = join(home, "scripted-host.mjs");
  await writeFile(
    entry,
    `
import {createInterface} from 'node:readline';
const out=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);
 if(message.method==='open') out({id:message.id,result:{agentId:message.params.policy==='restricted'?'restricted-agent':'unrestricted-agent'}});
 else if(message.method==='close') out({id:message.id,result:{disposed:true}});
});
`,
  );
  try {
    const session = await openCursorSession(
      {
        threadId: ThreadId.parse("permission"),
        cwd: home,
        permissionMode: "auto-review",
        runtimePolicy: "full-access",
        signal: new AbortController().signal,
        onFrame() {},
        onExit() {},
      },
      {
        entry,
        env: { HOME: home },
        instanceId: "instance",
        policy: "full-access",
        generation: () => "host",
        now: () => 1,
      },
    );
    try {
      expect(session.nativeSessionId).toBe("restricted-agent");
    } finally {
      await session.close("shutdown");
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
