import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { createCursorAdapter, type CursorAdapterOptions } from "@ace/adapter-cursor";
import type { SessionContext, ProviderSession } from "@ace/engine-api";
import { recordCursorSdkScenario, cursorSdkCapture } from "@ace/recorder/cursor-sdk";
import { readFixture } from "@ace/adapter-testkit";

// Synthetic provider service only: the public translator/core, filesystem capture,
// approval gate, scenario controls and cleanup are the production implementations.
function provider(options: CursorAdapterOptions, abort?: () => void) {
  const translator = createCursorAdapter(options);
  let generation = 0,
    identities = 0;
  const positions = new Map<string, number>();
  return {
    ...translator,
    async openSession(ctx: SessionContext): Promise<ProviderSession> {
      const host = `host-${++generation}`,
        agentId = ctx.resume?.nativeSessionId ?? `native-${++identities}`;
      let operation = "open",
        segment = 0,
        run = 0;
      const frame = async (kind: string, body: unknown) => {
        const offset = (positions.get(ctx.threadId) ?? 0) + 1;
        positions.set(ctx.threadId, offset);
        await ctx.onFrame({
          seq: offset,
          t: offset,
          dir: kind === "send" ? "send" : "recv",
          channel: "sdk",
          data: {
            schemaVersion: 1,
            generation: host,
            operationId: operation,
            segment,
            agentId,
            runId: run ? `${host}-run-${run}` : undefined,
            kind,
            body,
            boundaryOffset: offset,
          },
        });
      };
      ctx.onSessionIdentity?.({
        backend: "cursor-sdk",
        instanceId: options.instance?.id ?? "fixture",
        nativeSessionId: agentId,
      });
      await frame("open", { cwd: ctx.cwd, model: ctx.model });
      if (ctx.resume) await frame("snapshot", { revision: "checkpoint", offset: 0, items: [] });
      return {
        nativeSessionId: agentId,
        backend: "cursor-sdk" as const,
        instanceId: options.instance?.id ?? "fixture",
        async send(input, delivery, commandId) {
          if (delivery === "steer") segment++;
          else {
            operation = commandId ?? "command";
            segment = 0;
          }
          run++;
          await frame("send", { input });
          await frame("segment", { nativeRunId: `${host}-run-${run}` });
          if (abort) {
            await frame("delta", {
              type: "tool-call-started",
              callId: "child",
              toolCall: { type: "task", args: { description: "background", isBackground: true } },
            });
            await frame("delta", {
              type: "tool-call-completed",
              callId: "child",
              toolCall: {
                type: "task",
                result: { status: "success", value: { isBackground: true, agentId: "child" } },
              },
            });
          }
          const isolation =
            ctx.env?.HOME === join(options.instance?.homeDir ?? "", "user")
              ? "isolated"
              : "ambient";
          await frame("delta", {
            type: "text-delta",
            text: `${isolation} ${ctx.model} ${ctx.runtimePolicy}`,
          });
          await frame("result", { status: "finished" });
          abort?.();
        },
        async interrupt() {
          await frame("cancel", { settled: true });
        },
        async resolve() {
          throw new Error("unsupported");
        },
        async stopTask() {
          throw new Error("unsupported");
        },
        async close() {
          await frame("close", { disposed: true });
          ctx.onExit({ deliberate: true });
        },
      };
    },
  };
}
const rows = async (path: string) =>
  (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));

it("refuses unapproved SDK recording before creating artifacts or opening the provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdk-rec-approval-")),
    path = join(root, "capture.jsonl");
  try {
    await expect(
      recordCursorSdkScenario(
        {
          approval: { scenario: "full-access", approved: false },
          path,
          instance: { id: "fixture", homeDir: root },
          freshFixtureInstance: true,
          startedAt: "2026-10-03T00:00:00.000Z",
          platform: "synthetic",
        },
        {
          now: () => 0,
          id: () => "id",
          signal: new AbortController().signal,
          launchEnv: {},
          adapter: () => {
            throw new Error("Provider must not open");
          },
        },
      ),
    ).rejects.toBeInstanceOf(z.ZodError);
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  { scenario: "text-thinking-read", sdk: {}, message: "Auto-review" },
  { scenario: "restricted-mcp", sdk: { autoReviewAvailable: true }, message: "MCP lease" },
])(
  "refuses unsafe $scenario setup before creating a capture",
  async ({ scenario, sdk, message }) => {
    const root = await mkdtemp(join(tmpdir(), "sdk-rec-policy-")),
      path = join(root, "capture.jsonl");
    try {
      await expect(
        recordCursorSdkScenario(
          {
            approval: { scenario, approved: true },
            path,
            instance: { id: "fixture", homeDir: root },
            freshFixtureInstance: true,
            startedAt: "2026-10-03T00:00:00.000Z",
            platform: "synthetic",
          },
          {
            now: () => 0,
            id: () => "id",
            signal: new AbortController().signal,
            launchEnv: {},
            sdk,
            adapter: () => {
              throw new Error("Provider must not open");
            },
          },
        ),
      ).rejects.toThrow(message);
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("runs an explicitly approved behavioural full-access turn and labels its evidence without Auto-review", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdk-rec-full-access-option-"));
  const path = join(root, "capture.jsonl");
  let id = 0;
  try {
    await recordCursorSdkScenario(
      {
        approval: { scenario: "text-thinking-read", approved: true },
        recordingPolicy: "full-access",
        path,
        instance: { id: "fixture", homeDir: join(root, "instance") },
        freshFixtureInstance: true,
        startedAt: "2026-10-03T00:00:00.000Z",
        platform: "synthetic",
      },
      {
        now: () => 0,
        id: () => `id-${++id}`,
        signal: new AbortController().signal,
        launchEnv: {},
        adapter: provider,
        modelCatalog: async () => [],
      },
    );
    const data = await rows(path);
    expect(data[0]).toMatchObject({
      scenario: "text-thinking-read",
      recordingPolicy: "full-access",
      sandbox: false,
      autoReview: false,
    });
    expect(JSON.stringify(data)).toContain("isolated composer-2.5 full-access");
    expect(data.at(-1)).toMatchObject({
      observations: {
        recordingPolicy: "full-access",
        runtimePolicy: "full-access",
        outcome: "observed",
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses to turn MCP scenarios into full-access behavioural evidence", async () => {
  await expect(
    recordCursorSdkScenario(
      {
        approval: { scenario: "restricted-mcp", approved: true },
        recordingPolicy: "full-access",
        path: join(tmpdir(), "must-not-create-sdk-mcp.jsonl"),
        instance: { id: "fixture", homeDir: tmpdir() },
        freshFixtureInstance: true,
        startedAt: "2026-10-03T00:00:00.000Z",
        platform: "synthetic",
      },
      {
        now: () => 0,
        id: () => "id",
        signal: new AbortController().signal,
        launchEnv: {},
        adapter: () => {
          throw new Error("Provider must not open");
        },
      },
    ),
  ).rejects.toThrow("does not authorize MCP");
});

it.each(["full-access", "checkpoint-resume", "portable-fork"])(
  "records approved %s SDK workflow with isolated identity, complete output and redacted metadata",
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), "sdk-rec-workflow-")),
      path = join(root, "capture.jsonl");
    const secret = "sdk-model-sentinel-secret";
    let id = 0;
    try {
      const result = await recordCursorSdkScenario(
        {
          approval: { scenario, approved: true },
          path,
          instance: { id: "fixture", homeDir: join(root, "instance") },
          freshFixtureInstance: true,
          startedAt: "2026-10-03T00:00:00.000Z",
          platform: "synthetic",
        },
        {
          now: () => 0,
          id: () => `id-${++id}`,
          signal: new AbortController().signal,
          launchEnv: { HOME: "/ambient", CURSOR_API_KEY: secret },
          sdk: { autoReviewAvailable: true },
          adapter: provider,
          modelCatalog: async () => [
            { id: "composer-2.5", displayName: "Composer", apiKey: secret },
          ],
        },
      );
      const data = await rows(path),
        header = data[0];
      // Resume/fork restart source session clocks but must remain a readable recording.
      expect((await readFixture(path)).frames.length).toBeGreaterThan(0);
      expect(header).toMatchObject({
        provider: "cursor-sdk",
        sdkVersion: "1.0.35",
        model: "composer-2.5",
        sandbox: scenario !== "full-access",
        autoReview: scenario !== "full-access",
      });
      const serialized = JSON.stringify(data);
      expect(serialized).not.toContain(secret);
      expect(serialized).toContain(
        `isolated composer-2.5 ${scenario === "full-access" ? "full-access" : "restricted"}`,
      );
      expect(data.at(-1)).toMatchObject({
        type: "sdk-scenario-analysis",
        observations: { outcome: "observed" },
      });
      expect(result.observations.every((value) => value.status.state === "done")).toBe(true);
      if (scenario === "checkpoint-resume") {
        expect(result.resumed).toBe(true);
        expect(result.observations[0]?.nativeAgentIds).toEqual(["native-1"]);
        expect(result.observations[0]?.observedKinds).toContain("snapshot");
        expect(result.observations[0]?.aceRunIds).toHaveLength(2);
      }
      if (scenario === "portable-fork") {
        expect(result.forked).toBe(true);
        expect(result.observations.map((value) => value.nativeAgentIds)).toEqual([
          ["native-1"],
          ["native-2"],
        ]);
        expect(serialized).toContain("sourceThreadId");
        expect(result.observations[0]?.status.state).toBe("done");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("does not promote root completion into a complete recording while background work remains unresolved", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdk-rec-unresolved-")),
    path = join(root, "capture.jsonl");
  const stop = new AbortController();
  let id = 0;
  try {
    await expect(
      recordCursorSdkScenario(
        {
          approval: { scenario: "background-shell", approved: true },
          path,
          instance: { id: "fixture", homeDir: join(root, "instance") },
          freshFixtureInstance: true,
          startedAt: "2026-10-03T00:00:00.000Z",
          platform: "synthetic",
        },
        {
          now: () => 0,
          id: () => `id-${++id}`,
          signal: stop.signal,
          launchEnv: {},
          sdk: { autoReviewAvailable: true },
          adapter: (options) => provider(options, () => stop.abort()),
          modelCatalog: async () => [],
        },
      ),
    ).rejects.toThrow("incomplete");
    const data = await rows(path);
    const report = z
      .object({
        observations: z.object({
          outcome: z.string(),
          threads: z.array(z.object({ status: z.object({ state: z.string() }) })),
        }),
      })
      .parse(data.at(-1));
    expect(report.observations.outcome).toBe("incomplete");
    expect(report.observations.threads[0]?.status.state).not.toBe("done");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("marks a steering attempt incomplete if the root finished before the replacement boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdk-rec-steer-")),
    path = join(root, "capture.jsonl");
  let id = 0;
  try {
    await expect(
      recordCursorSdkScenario(
        {
          approval: { scenario: "steering-restart", approved: true },
          path,
          instance: { id: "fixture", homeDir: join(root, "instance") },
          freshFixtureInstance: true,
          startedAt: "2026-10-03T00:00:00.000Z",
          platform: "synthetic",
        },
        {
          now: () => 0,
          id: () => `id-${++id}`,
          signal: new AbortController().signal,
          launchEnv: {},
          sdk: { autoReviewAvailable: true },
          adapter: provider,
          modelCatalog: async () => [],
        },
      ),
    ).rejects.toThrow("incomplete");
    const data = await rows(path);
    const report = z
      .object({
        observations: z.object({
          outcome: z.string(),
          threads: z.array(z.object({ aceRunIds: z.array(z.string()) })),
        }),
      })
      .parse(data.at(-1));
    expect(report.observations.outcome).toBe("incomplete");
    expect(report.observations.threads[0]?.aceRunIds).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("excludes SDK auth and non-SDK channels from a capture instead of persisting a browser challenge", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdk-rec-auth-")),
    path = join(root, "capture.jsonl");
  const capture = cursorSdkCapture(
    path,
    {
      format: "ace-recording/v1",
      provider: "cursor-sdk",
      sdkVersion: "1.0.35",
      cliVersion: "1.0.35",
      model: "composer-2.5",
      scenario: "full-access",
      sandbox: false,
      autoReview: false,
      checkpointExpected: true,
      workspace: root,
      platform: "synthetic",
      startedAt: "2026-10-03T00:00:00.000Z",
    },
    { scenario: "full-access", approved: true },
  );
  const secret = "https://cursor.com/challenge/one-time-sentinel";
  try {
    const frame = {
      seq: 1,
      t: 1,
      dir: "recv" as const,
      channel: "sdk",
      data: {
        schemaVersion: 1,
        generation: "host",
        operationId: "auth",
        segment: 0,
        kind: "login",
        body: { url: secret },
      },
    };
    expect(() => capture.frame(frame)).toThrow("auth");
    expect(() => capture.frame({ ...frame, channel: "auth" })).toThrow("ACP/auth");
    await capture.close();
    expect(await readFile(path, "utf8")).not.toContain(secret);
  } finally {
    await capture.close();
    await rm(root, { recursive: true, force: true });
  }
});
