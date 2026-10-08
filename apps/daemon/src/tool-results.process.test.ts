import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { toolFixture } from "./tool-result-test-support.ts";

for (const provider of ["claude", "opencode", "pi", "cursor", "codex", "acp"] as const)
  it(`${provider} exposes an ace result and thread-owned image independently of native result envelopes`, async () => {
    const f = await toolFixture(provider);
    try {
      const items = Object.values(f.daemon.store.snapshotThread(f.thread.id).items);
      const item = items.find((entry) => entry.type === "tool_call");
      if (item?.type !== "tool_call") throw new Error("Missing tool call");
      expect(item.call.detail).toMatchObject({
        kind: "mcp",
        server: "ace",
        tool: "screen_measure_interaction",
      });
      expect(item.call.result).toMatchObject({
        isError: false,
        durationMs: expect.any(Number),
        content: [
          expect.objectContaining({ type: "text" }),
          expect.objectContaining({ type: "image" }),
        ],
      });
      const image = item.call.result?.content.find((part) => part.type === "image");
      if (image?.type !== "image") throw new Error("No captured image");
      const token = (await readFile(f.daemon.tokenPath, "utf8")).trim();
      const response = await fetch(
        `${f.daemon.url.replace(/^ws/, "http")}/v1/attachments/${f.thread.id}/${image.attachment.sha256}/original`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes);
      await expect(
        f.daemon.context.uploads.handle("local", {
          op: "attachment.release",
          threadId: f.thread.id,
          sha256: image.attachment.sha256,
        }),
      ).rejects.toThrow();
      const notice = items.find((entry) => entry.type === "notice" && entry.code === "screen.step");
      expect(notice).toMatchObject({
        toolCallId: item.id,
        raw: [
          {
            data: {
              toolCallId: item.id,
              action: "screen_measure_interaction",
              outcome: "completed",
            },
          },
        ],
      });
    } finally {
      await f.close();
    }
  });

it("screen notices identify the calling step and target after the action", async () => {
  const f = await toolFixture("claude", { tool: "screen_click", input: { x: 1, y: 1 } });
  try {
    const items = Object.values(f.daemon.store.snapshotThread(f.thread.id).items);
    const item = items.find((entry) => entry.type === "tool_call");
    if (item?.type !== "tool_call") throw new Error("No tool");
    expect(item.call.result).toMatchObject({
      target: { bundleId: "dev.ace.test", windowId: 1 },
      mode: "background",
    });
    expect(
      items.filter((entry) => entry.type === "notice" && entry.code === "screen.step"),
    ).toMatchObject([
      {
        toolCallId: item.id,
        raw: [
          {
            data: {
              toolCallId: item.id,
              bundleId: "dev.ace.test",
              windowId: 1,
              mode: "background",
              outcome: "completed",
            },
          },
        ],
      },
    ]);
  } finally {
    await f.close();
  }
});

for (const provider of ["claude", "opencode", "pi", "acp"] as const)
  it(`${provider} redacts secure-field text in arguments, results and raw evidence`, async () => {
    const f = await toolFixture(provider, {
      tool: "screen_type",
      input: { text: "unique-secret-123" },
      helperEnv: { SECURE_TEXT: "1" },
      error: true,
    });
    try {
      const view = f.daemon.store.snapshotThread(f.thread.id);
      expect(JSON.stringify(view)).not.toContain("unique-secret-123");
      expect(
        JSON.stringify(
          f.daemon.store.readEvents({ afterSeq: 0, threadId: f.thread.id, limit: 1000 }),
        ),
      ).not.toContain("unique-secret-123");
      const item = Object.values(view.items).find((entry) => entry.type === "tool_call");
      expect(item).toMatchObject({
        call: {
          status: "failed",
          detail: {
            kind: "mcp",
            server: "ace",
            tool: "screen_type",
            arguments: { text: "[redacted]" },
          },
          result: { isError: true },
        },
      });
      expect(JSON.stringify(item)).toContain("Secure text requires session consent");
    } finally {
      await f.close();
    }
  });

it("typed results and attachment ownership survive restart and result-less provider updates", async () => {
  const f = await toolFixture("claude", { late: true });
  try {
    const item = Object.values(f.daemon.store.snapshotThread(f.thread.id).items).find(
      (entry) => entry.type === "tool_call",
    );
    if (item?.type !== "tool_call") throw new Error("No tool");
    await f.restart();
    const { result: _capture, ...providerCall } = item.call;
    f.daemon.store.appendEvents(f.thread.id, [
      { type: "item.updated", item: { ...item, call: { ...providerCall, raw: [] } } },
    ]);
    expect(f.daemon.store.snapshotThread(f.thread.id).items[item.id]).toMatchObject({
      call: { result: item.call.result },
    });
    const image = item.call.result?.content.find((part) => part.type === "image");
    if (image?.type !== "image") throw new Error("No image");
    await expect(
      f.daemon.context.uploads.handle("local", {
        op: "attachment.release",
        threadId: f.thread.id,
        sha256: image.attachment.sha256,
      }),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it.each([
  { message: "Text destination changed", detail: "Text destination changed" },
  { message: "Text destination changed\nsecret-token-123 /private/user/path", detail: undefined },
])(
  "helper error details retain only reviewed safe messages ($message)",
  async ({ message, detail }) => {
    const f = await toolFixture("claude", {
      tool: "screen_click",
      input: { x: 1, y: 1 },
      helperEnv: { RESULT_ERROR_CODE: "focus_changed", RESULT_ERROR_MESSAGE: message },
      error: true,
    });
    try {
      const view = f.daemon.store.snapshotThread(f.thread.id);
      const item = Object.values(view.items).find((entry) => entry.type === "tool_call");
      if (item?.type !== "tool_call") throw new Error("No tool");
      const text = item.call.result?.content.find((part) => part.type === "text");
      if (text?.type !== "text") throw new Error("No error text");
      const failure: unknown = JSON.parse(text.text);
      expect(failure).toMatchObject({
        code: "focus_changed",
        message: "Background action changed focus or cursor",
      });
      expect(failure).toEqual(
        expect.objectContaining(detail ? { detail } : { code: "focus_changed" }),
      );
      expect(JSON.stringify(failure)).not.toContain("secret-token-123");
      if (!detail) expect(failure).not.toHaveProperty("detail");
    } finally {
      await f.close();
    }
  },
);

it.each([
  { tool: "screen_screenshot", input: {} },
  { tool: "screen_ui_tree", input: {} },
  { tool: "screen_ui_find", input: { query: { name: "Click" } } },
  { tool: "screen_open_app", input: { bundleId: "dev.ace.test" } },
  { tool: "screen_request_foreground", input: { reason: "Confirm target" } },
  { tool: "screen_request_app", input: { bundleId: "dev.ace.test", reason: "Inspect document" } },
])(
  "$tool records a linked result notice, including reads and approval actions",
  async ({ tool, input }) => {
    const f = await toolFixture("claude", { tool, input });
    try {
      const items = Object.values(f.daemon.store.snapshotThread(f.thread.id).items);
      const item = items.find((entry) => entry.type === "tool_call");
      if (item?.type !== "tool_call") throw new Error("No tool");
      expect(item.call.result).toMatchObject({
        isError: false,
        target: { bundleId: "dev.ace.test" },
      });
      if (tool === "screen_request_foreground") expect(item.call.result?.mode).toBe("foreground");
      if (tool === "screen_screenshot")
        expect(item.call.result).toMatchObject({
          scale: 1,
          size: { width: 120, height: 24 },
          content: [
            expect.objectContaining({ type: "image" }),
            expect.objectContaining({ type: "text" }),
          ],
        });
      expect(
        items.filter((entry) => entry.type === "notice" && entry.code === "screen.step"),
      ).toMatchObject([
        {
          toolCallId: item.id,
          raw: [{ data: { toolCallId: item.id, bundleId: "dev.ace.test", outcome: "completed" } }],
        },
      ]);
    } finally {
      await f.close();
    }
  },
);

it.each(["denied", "timeout", "read_only"] as const)(
  "screen approval %s uses screen wording",
  async (code) => {
    const f = await toolFixture("claude", {
      tool: "screen_request_app",
      input: { bundleId: "dev.ace.test", reason: "Inspect" },
      approvalFailure: code,
      error: true,
    });
    try {
      const item = Object.values(f.daemon.store.snapshotThread(f.thread.id).items).find(
        (entry) => entry.type === "tool_call",
      );
      if (item?.type !== "tool_call") throw new Error("No tool");
      expect(item.call.error).toMatch(/Screen/);
      expect(item.call.error).not.toMatch(/Browser|navigation/);
    } finally {
      await f.close();
    }
  },
);

it("pre-dispatch permission failure retains the missing permission and a linked warning notice", async () => {
  const f = await toolFixture("claude", {
    tool: "screen_click",
    input: { x: 1, y: 1 },
    helperEnv: { REVOKE_ACCESS: "1" },
    error: true,
  });
  try {
    const items = Object.values(f.daemon.store.snapshotThread(f.thread.id).items);
    const item = items.find((entry) => entry.type === "tool_call");
    if (item?.type !== "tool_call") throw new Error("No tool");
    const text = item.call.result?.content.find((part) => part.type === "text");
    if (text?.type !== "text") throw new Error("No error content");
    const failure: unknown = JSON.parse(text.text);
    expect(failure).toMatchObject({ code: "permission_denied", permission: "accessibility" });
    expect(
      items.find((entry) => entry.type === "notice" && entry.code === "screen.step"),
    ).toMatchObject({
      toolCallId: item.id,
      level: "warning",
      raw: [{ data: { outcome: "permission_denied" } }],
    });
  } finally {
    await f.close();
  }
});

it("identical ambiguous provider steps do not receive another step's result", async () => {
  const f = await toolFixture("claude", { duplicate: true });
  try {
    const items = Object.values(f.daemon.store.snapshotThread(f.thread.id).items);
    expect(items.filter((entry) => entry.type === "tool_call" && entry.call.result)).toEqual([]);
    expect(
      items.find((entry) => entry.type === "notice" && entry.code === "screen.step"),
    ).not.toHaveProperty("toolCallId");
  } finally {
    await f.close();
  }
});

it("ace_status captures its structured result despite using the discovery registry", async () => {
  const f = await toolFixture("claude", { tool: "ace_status", input: {} });
  try {
    const item = Object.values(f.daemon.store.snapshotThread(f.thread.id).items).find(
      (entry) => entry.type === "tool_call",
    );
    expect(item).toMatchObject({
      call: {
        detail: { kind: "mcp", server: "ace", tool: "ace_status" },
        result: {
          isError: false,
          structuredContent: { threadId: f.thread.id, groups: expect.any(Array) },
        },
      },
    });
  } finally {
    await f.close();
  }
});

it("consented secure-field input succeeds without retaining its text or post-input snapshots", async () => {
  const f = await toolFixture("pi", {
    tool: "screen_type",
    input: { text: "secure-success-secret" },
    helperEnv: { SECURE_TEXT: "1" },
    secureConsent: true,
  });
  try {
    const view = f.daemon.store.snapshotThread(f.thread.id);
    const item = Object.values(view.items).find((entry) => entry.type === "tool_call");
    expect(item).toMatchObject({
      call: {
        status: "succeeded",
        result: { isError: false, content: [{ type: "text", text: "[redacted]" }] },
      },
    });
    expect(JSON.stringify(view)).not.toContain("secure-success-secret");
    expect(
      JSON.stringify(
        f.daemon.store.readEvents({ afterSeq: 0, threadId: f.thread.id, limit: 1000 }),
      ),
    ).not.toContain("secure-success-secret");
  } finally {
    await f.close();
  }
});
