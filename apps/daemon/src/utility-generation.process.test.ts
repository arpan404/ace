import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SettingsService, fileIO } from "@ace/settings";
import { CatalogModel, type ProviderKind, type ThreadId } from "@ace/protocol";
import type { UtilityModel } from "@ace/models";
import { modelEfforts } from "@ace/models/efforts";
import { harness, scriptFrames, start, end } from "./engine/test-support.ts";
import { createWritingCli } from "./source-control-cli.ts";
import { createUtility, type UtilityService } from "./utility-models.ts";
import { readyStatus } from "./utility-test-support.ts";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).toReversed()) await close();
});

const row = (provider: ProviderKind, id: string) =>
  CatalogModel.parse({
    id,
    displayName: id,
    provider,
    instance: `${provider}-cli-default`,
    nativeModelId: id,
    efforts: modelEfforts(["low", "medium"]),
    serviceTiers: [],
    inputModalities: ["text"],
    isDefault: false,
    hidden: false,
    deprecated: false,
    raw: { json: "{}", truncated: false },
  });
const catalog = [
  row("codex", "gpt-6.1-sol"),
  row("codex", "gpt-6-luna"),
  row("claude", "claude-opus-5-5"),
  row("claude", "claude-haiku-4-5"),
];

async function settingsIn(dataDir: string) {
  const settings = new SettingsService({
    dataDir,
    io: { ...fileIO, watch: async () => () => {} },
    scheduler: { schedule: () => () => {} },
  });
  return settings;
}

/**
 * A scripted engine thread whose utility model is a recorded fake run: each call keeps the
 * model it ran on and its prompt, and answers with `reply`.
 */
async function setup(reply: (target: UtilityModel, prompt: string) => Promise<string>) {
  const calls: { target: UtilityModel; prompt: string }[] = [];
  let utility: UtilityService | undefined;
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
    { onNamingPrompt: (id, input) => utility?.titles.namingPrompt(id, input) },
  );
  const dataDir = await mkdtemp(join(tmpdir(), "ace-utility-"));
  const settings = await settingsIn(dataDir);
  closes.push(async () => {
    utility?.titles.close();
    await h.close();
    await settings.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  utility = createUtility({
    settings,
    statuses: () => [readyStatus("codex"), readyStatus("claude")],
    models: (provider) => catalog.filter((model) => model.provider === provider),
    run: async (target, run) => {
      calls.push({ target, prompt: run.prompt });
      return reply(target, run.prompt);
    },
    store: h.store,
    now: () => h.clock.now(),
  });
  const send = async (id: ThreadId, text: string) => {
    h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text }] });
    await h.engine.flush();
  };
  return { h, calls, settings, utility, send };
}

test("a thread's title is generated once, from the message that named it", async () => {
  const { h, calls, send } = await setup(async () => "“Fix the flaky login test.”");
  const id = await h.create();
  await vi.waitFor(() =>
    expect(h.store.getThread(id)).toMatchObject({
      title: "Fix the flaky login test",
      titleSource: "generated",
    }),
  );
  await send(id, "Also check the signup page");
  await send(id, "And the password reset");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.prompt).toContain("first");
  expect(h.store.getThread(id)?.title).toBe("Fix the flaky login test");
});

test("a failed title generation keeps the first-words title and shows nothing", async () => {
  const { h, calls } = await setup(async () => {
    throw new Error("utility_provider_failed");
  });
  const id = await h.create();
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  await h.engine.flush();
  expect(h.store.getThread(id)).toMatchObject({ title: "first", titleSource: "provisional" });
  const items = Object.values(h.store.snapshotThread(id).items);
  expect(items.filter((item) => item.type !== "message")).toEqual([]);
  expect(h.errors).toEqual([]);
});

const draftInput = {
  generationId: "draft",
  selection: { kind: "commit" as const, paths: ["a.ts"] },
  fingerprint: "0".repeat(64),
  preference: "",
};
const draftContext = {
  fingerprint: "0".repeat(64),
  head: null,
  base: null,
  paths: ["a.ts"],
  patch: "+a\n",
  truncated: false,
  conventions: [],
  recentCommits: "",
};

test.each([
  ["nothing chosen", null, "codex", "gpt-6-luna"],
  [
    "the person's choice",
    { provider: "claude" as const, model: "claude-opus-5-5" },
    "claude",
    "claude-opus-5-5",
  ],
])(
  "with %s, titles and commit drafts both run on that model",
  async (_label, choice, provider, model) => {
    const { h, calls, settings, utility } = await setup(async (_target, prompt) =>
      prompt.includes("commit message") ? JSON.stringify({ subject: "Add a", body: "" }) : "Add a",
    );
    if (choice) await settings.set("generation.model", choice, { kind: "global" });
    await h.create();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const write = createWritingCli({
      generate: (prompt, signal, limits) => utility.models.generate(prompt, signal, limits),
    });
    expect(await write(draftInput, draftContext, "", new AbortController().signal)).toEqual({
      subject: "Add a",
      body: "",
    });
    expect(calls.map((call) => [call.target.provider, call.target.model])).toEqual([
      [provider, model],
      [provider, model],
    ]);
  },
);

test("the utility model choice is kept by the daemon that saved it, across restarts", async () => {
  const roots = [
    await mkdtemp(join(tmpdir(), "ace-utility-a-")),
    await mkdtemp(join(tmpdir(), "ace-utility-b-")),
  ];
  closes.push(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });
  const [a, b] = roots as [string, string];
  const first = await settingsIn(a);
  await first.set(
    "generation.model",
    { provider: "claude", model: "claude-opus-5-5", effort: "low" },
    { kind: "global" },
  );
  await first.close();
  const resolveIn = async (dataDir: string) => {
    const settings = await settingsIn(dataDir);
    try {
      const { h } = await setup(async () => "");
      return await createUtility({
        settings,
        statuses: () => [readyStatus("codex"), readyStatus("claude")],
        models: (provider) => catalog.filter((model) => model.provider === provider),
        run: async () => "",
        store: h.store,
        now: () => 1,
      }).models.resolve();
    } finally {
      await settings.close();
    }
  };
  expect(await resolveIn(a)).toMatchObject({
    provider: "claude",
    model: "claude-opus-5-5",
    effort: "low",
    chosen: true,
  });
  expect(await resolveIn(b)).toMatchObject({ provider: "codex", model: "gpt-6-luna" });
  const project = await settingsIn(a);
  await expect(
    project.set("generation.model", null, { kind: "workspace", workspace: dirname(a) }),
  ).rejects.toThrow("Generation settings belong to the daemon");
  await project.close();
});
