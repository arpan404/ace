import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { toolFixture as fixture } from "./tool-result-test-support.ts";

for (const provider of ["codex", "claude", "opencode", "cursor", "pi", "acp"] as const)
  it(`${provider} attaches daemon measurement to the calling step and serves its thread-owned filmstrip`, async () => {
    const f = await fixture(provider, { large: provider === "codex" });
    try {
      const items = Object.values(f.daemon.store.snapshotThread(f.thread.id).items);
      const measured = items.filter((item) => item.type === "tool_call" && item.measurement);
      expect(measured).toHaveLength(1);
      const item = measured[0];
      if (item?.type !== "tool_call" || !item.measurement?.filmstrip)
        throw new Error("Missing step filmstrip");
      expect(item.call.status).toBe("succeeded");
      expect(item.measurement.verdict).toBe("smooth");
      expect(items.filter((entry) => entry.type === "notice" && entry.measurement)).toEqual([]);
      if (provider === "claude") expect(JSON.stringify(item.call.raw)).toContain('"tool_use"');
      if (provider === "codex") expect(item.call.raw.some((raw) => "blobRef" in raw)).toBe(true);
      const token = (await readFile(f.daemon.tokenPath, "utf8")).trim();
      const url = `${f.daemon.url.replace(/^ws/, "http")}/v1/attachments/${f.thread.id}/${item.measurement.filmstrip.sha256}/original`;
      expect((await fetch(url)).status).toBe(401);
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/jpeg");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes);
      await expect(
        f.daemon.context.uploads.handle("local", {
          op: "attachment.release",
          threadId: f.thread.id,
          sha256: item.measurement.filmstrip.sha256,
        }),
      ).rejects.toThrow();
      const retained = await f.daemon.context.uploads.attachment(
        "local",
        f.thread.id,
        item.measurement.filmstrip.sha256,
      );
      f.daemon.store.appendEvents(f.thread.id, [
        { type: "thread.client.updated", changes: { deletedAt: Date.now() } },
      ]);
      await f.daemon.context.uploads.collect();
      await expect(readFile(retained.path)).rejects.toThrow();
      expect((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status).not.toBe(
        200,
      );
    } finally {
      await f.close();
    }
  });

it("late provider frames replace the standalone fallback with evidence on the exact tool step", async () => {
  const f = await fixture("claude", { late: true });
  try {
    const items = Object.values(f.daemon.store.snapshotThread(f.thread.id).items);
    expect(items.filter((item) => item.type === "tool_call" && item.measurement)).toHaveLength(1);
    expect(items.filter((item) => item.type === "notice" && item.measurement)).toEqual([]);
  } finally {
    await f.close();
  }
});

it.each([{ omit: true }, { duplicate: true }])(
  "missing or ambiguous call correlation preserves a standalone measurement (%j)",
  async (options) => {
    const f = await fixture("claude", options);
    try {
      const items = Object.values(f.daemon.store.snapshotThread(f.thread.id).items);
      expect(items.filter((item) => item.type === "tool_call" && item.measurement)).toEqual([]);
      expect(items.filter((item) => item.type === "notice" && item.measurement)).toMatchObject([
        {
          complete: true,
          measurement: { verdict: "smooth", filmstrip: { mimeType: "image/jpeg" } },
        },
      ]);
    } finally {
      await f.close();
    }
  },
);

it("daemon evidence and attachment ownership survive restart and later provider upserts without raw results", async () => {
  const f = await fixture("claude");
  try {
    const original = Object.values(f.daemon.store.snapshotThread(f.thread.id).items).find(
      (entry) => entry.type === "tool_call" && entry.measurement,
    );
    if (original?.type !== "tool_call" || !original.measurement?.filmstrip)
      throw new Error("No measurement");
    await f.restart();
    const { measurement: _daemonEvidence, ...native } = original;
    f.daemon.store.appendEvents(f.thread.id, [
      {
        type: "item.updated",
        item: { ...native, call: { ...native.call, title: "Provider updated the step", raw: [] } },
      },
    ]);
    expect(f.daemon.store.snapshotThread(f.thread.id).items[original.id]).toMatchObject({
      measurement: original.measurement,
      call: { title: "Provider updated the step", raw: [] },
    });
    const token = (await readFile(f.daemon.tokenPath, "utf8")).trim();
    const response = await fetch(
      `${f.daemon.url.replace(/^ws/, "http")}/v1/attachments/${f.thread.id}/${original.measurement.filmstrip.sha256}/original`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes);
  } finally {
    await f.close();
  }
});

it("browser MCP uses the same daemon evidence and attachment path with a large filmstrip", async () => {
  const f = await fixture("claude", { browser: true, large: true });
  try {
    const item = Object.values(f.daemon.store.snapshotThread(f.thread.id).items).find(
      (entry) => entry.type === "tool_call" && entry.measurement,
    );
    if (item?.type !== "tool_call" || !item.measurement?.filmstrip)
      throw new Error("No browser evidence");
    expect(item.call.detail).toMatchObject({
      kind: "mcp",
      tool: "ace_browser_measure_interaction",
    });
    expect(item.measurement).toMatchObject({
      source: "browser-trace",
      target: { threadId: f.thread.id },
      verdict: "smooth",
    });
    const attachment = await f.daemon.context.uploads.attachment(
      "local",
      f.thread.id,
      item.measurement.filmstrip.sha256,
    );
    expect(await readFile(attachment.path)).toEqual(f.bytes);
  } finally {
    await f.close();
  }
});
