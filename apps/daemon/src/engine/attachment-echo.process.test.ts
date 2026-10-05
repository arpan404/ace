import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { createTranslator as claude } from "@ace/adapter-claude";
import { createPiTranslator as pi } from "@ace/adapter-pi";
import { OpenCodeTranslator } from "@ace/adapter-opencode";
import { createCodexTranslator as codex } from "@ace/adapter-codex";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { Attachment, Capabilities, Command } from "@ace/protocol";
import { Engine } from "@ace/daemon";
import { harness, scriptFrames } from "./test-support.ts";

const capabilities = Capabilities.parse({
  steer: false,
  interruptCascades: false,
  resume: true,
  fork: false,
  subagentTranscripts: true,
  backgroundTaskControl: false,
  backgroundVisibility: "none",
  planMode: false,
  tokenUsage: false,
  imageInput: true,
  rewindFiles: false,
});
const translators = {
  claude,
  pi,
  opencode: (init: Parameters<typeof codex>[0]) => new OpenCodeTranslator(init),
  codex,
};
async function fixture(
  provider: keyof typeof translators,
  imageOnly = false,
  extra: unknown = { retained: true },
) {
  const bytes = await readFile(
    new URL("../../../../packages/context/fixtures/colours.png", import.meta.url),
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const attachment = Attachment.parse({
    sha256,
    name: "screen.png",
    mimeType: "image/png",
    bytes: bytes.length,
    width: 320,
    height: 240,
    thumbnailAvailable: true,
  });
  const url = `data:image/png;base64,${bytes.toString("base64")}`;
  const path = `/private/context/blobs/${sha256}.png`;
  let seq = 0,
    replay = false;
  const frame = (
    data: unknown,
    channel: string = provider === "claude" ? "sdk" : "stdio",
    dir: "send" | "recv" = "recv",
  ) => {
    const payload = new ProviderPayload(JSON.stringify(data));
    return { seq: ++seq, t: seq, dir, channel, data: payload.data, payload };
  };
  const echo = () =>
    provider === "claude"
      ? frame({
          type: "user",
          uuid: "user-1",
          extra,
          message: {
            content: [
              ...(imageOnly ? [] : [{ type: "text", text: "look" }]),
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") },
              },
            ],
          },
        })
      : provider === "pi"
        ? frame({
            type: "message_end",
            extra,
            message: {
              role: "user",
              content: [
                ...(imageOnly ? [] : [{ type: "text", text: "look" }]),
                { type: "image", mimeType: "image/png", data: bytes.toString("base64") },
              ],
            },
          })
        : provider === "opencode"
          ? frame(
              {
                method: "POST",
                path: "/api/session/native-1/prompt",
                body: {
                  id: "user-1",
                  text: "look",
                  files: [{ uri: url }],
                  extra,
                },
              },
              "http",
              "send",
            )
          : frame({
              method: "item/completed",
              params: {
                threadId: "native-1",
                turnId: "turn",
                item: {
                  id: "user-1",
                  type: "userMessage",
                  content: [
                    { type: "text", text: "look" },
                    { type: "localImage", path },
                  ],
                  extra,
                },
              },
            });
  const init = () =>
    provider === "opencode"
      ? frame({ method: "POST", path: "/api/session", body: { data: { id: "native-1" } } }, "http")
      : provider === "codex"
        ? frame({ method: "thread/started", params: { thread: { id: "native-1", cwd: "/repo" } } })
        : undefined;
  const scripted = createScriptedAdapter({
    provider,
    capabilities,
    steps: [],
    nativeSessionId: "native-1",
    createTranslator: translators[provider],
  });
  const h = await harness([], scriptFrames(), {
    provider,
    nativeAdapter: {
      ...scripted,
      async openSession(ctx) {
        const session = await scripted.openSession(ctx);
        const initial = init();
        if (initial) await ctx.onFrame(initial);
        if (replay) await ctx.onFrame(echo());
        return {
          ...session,
          async send(input, delivery, id) {
            await session.send(input, delivery, id);
            // Codex deliberately crashes before a transcript echo is persisted.
            if (provider !== "codex") await ctx.onFrame(echo());
            else
              await ctx.onFrame(
                frame({
                  method: "turn/started",
                  params: { threadId: "native-1", turn: { id: "turn" } },
                }),
              );
          },
        };
      },
    },
    prepareInput: async () => ({
      input: [
        { type: "text", text: "look" },
        { type: "image", mimeType: "image/png", url },
      ],
      attachments: [attachment],
      release() {},
    }),
  });
  const result = h.command({
    type: "thread.create",
    workspaceId: h.workspace,
    provider,
    input: [{ type: "text", text: "look" }],
    context: { mentions: [], attachments: [{ sha256 }] },
  });
  if (!result.ok || !result.threadId) throw new Error("Creation failed");
  await h.engine.flush();
  return {
    ...h,
    threadId: result.threadId,
    attachment,
    bytes,
    replay: () => {
      replay = true;
    },
  };
}

for (const provider of ["claude", "pi", "opencode"] as const) {
  test(`${provider} native user echoes retain attachment metadata and unrelated raw fields without image originals`, async () => {
    const h = await fixture(provider);
    try {
      const client = await h.connect("reader");
      client.send({
        type: "items.page",
        requestId: "echo",
        threadId: h.threadId,
        before: Number.MAX_SAFE_INTEGER,
        limit: 20,
      });
      const page = await client.next();
      if (page.type !== "items.page") throw new Error("Expected item page");
      const message = page.items.find((item) => item.type === "message" && item.role === "user");
      expect(message).toMatchObject({
        attachments: [h.attachment],
        parts: [{ type: "text", text: "look" }],
      });
      expect(JSON.stringify(message)).toContain('"retained":true');
      expect(JSON.stringify(message)).not.toContain(h.bytes.toString("base64"));
      expect(JSON.stringify(message)).not.toContain("/private/context");
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  });
}

for (const provider of ["claude", "pi"] as const) {
  test(`${provider} image-only native user envelopes still publish an attachment item`, async () => {
    const h = await fixture(provider, true);
    try {
      const page = h.store.readItemPage(h.threadId, Number.MAX_SAFE_INTEGER, 20);
      const users = page.items.filter((item) => item.type === "message" && item.role === "user");
      // The admitted bubble owns the metadata even when the image-only echo cannot match its text.
      expect(users.find((item) => item.id.startsWith("input:"))).toMatchObject({
        parts: [{ type: "text", text: "look" }],
        attachments: [h.attachment],
      });
      for (const item of users) expect(item).toMatchObject({ attachments: [h.attachment] });
      expect(JSON.stringify(page.items)).not.toContain(h.bytes.toString("base64"));
    } finally {
      await h.close();
    }
  });
}

test("attachment user echoes preserve deeply nested unknown native fields without poisoning the provider", async () => {
  let extra: unknown = "deep-original-field";
  for (let n = 0; n < 3000; n++) extra = { nested: extra };
  const h = await fixture("claude", false, { tree: extra, filler: "x".repeat(70 * 1024) });
  try {
    const page = h.store.readItemPage(h.threadId, Number.MAX_SAFE_INTEGER, 20);
    const message = page.items.find((item) => item.type === "message" && item.role === "user");
    expect(message).toMatchObject({ attachments: [h.attachment] });
    if (message?.type !== "message") throw new Error("Missing user item");
    const raw = message.raw[0];
    if (!raw || !("blobRef" in raw)) throw new Error("Expected bounded raw reference");
    const native = h.engine.readRawBlob(raw.blobRef);
    expect(native).toBeDefined();
    const serialized = Buffer.from(native ?? []).toString();
    expect(serialized).toContain("deep-original-field");
    expect(serialized).not.toContain(h.bytes.toString("base64"));
    expect(JSON.stringify(message)).not.toContain(h.bytes.toString("base64"));
    expect(h.errors).toEqual([]);
  } finally {
    await h.close();
  }
});

test("a resumed native echo resolves attachments even when the daemon stopped before persisting any user item", async () => {
  const h = await fixture("codex");
  let restarted: Engine | undefined;
  try {
    await h.engine.close();
    h.replay();
    // A corrupt, unrelated cold transcript record must not block native resume.
    // This is an SQLite boundary fault, exposing accidental whole-history decoding.
    h.store.atomic((db) =>
      db
        .prepare("INSERT INTO engine_state_records VALUES (?, 'items', 'cold-unrelated', '{}')")
        .run(h.threadId),
    );
    restarted = new Engine(h.store, {
      registry: h.registry,
      clock: h.clock,
      onError: (error) => h.errors.push(error),
    });
    await restarted.ready();
    const command = Command.parse({
      id: "resume",
      deviceId: "reader",
      payload: {
        type: "thread.resume",
        threadId: h.threadId,
        expectedRevision: restarted.queue(h.threadId).revision,
      },
    });
    const resumed = h.store.recordCommand(command.id, command.deviceId, () => {
      if (!restarted) throw new Error("Missing engine");
      return restarted.handler.handle(command, h.store);
    });
    expect(resumed).toMatchObject({ ok: true });
    await restarted.flush();
    const page = h.store.readItemPage(h.threadId, Number.MAX_SAFE_INTEGER, 20);
    const users = page.items.filter(
      (item) => item.type === "message" && item.role === "user" && item.id !== "input:resume",
    );
    expect(users.length).toBeGreaterThan(0);
    for (const item of users) expect(item).toMatchObject({ attachments: [h.attachment] });
    expect(JSON.stringify(users)).not.toContain("/private/context");
    expect(h.errors).toEqual([]);
  } finally {
    await restarted?.close();
    await h.close();
  }
});
