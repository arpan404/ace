import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { ContextService } from "@ace/context";
import { Agent, ThreadId } from "@ace/protocol";
import { Store } from "./store.ts";
import { createDevThread } from "./commands.ts";
import { startDaemonMcp } from "./mcp.ts";
import { htmlPublication, retainsHtml } from "./html-publication.ts";
import { invoke, Result } from "./browser-mcp-test-support.ts";

test("preview does not publish; rendered HTML replays after daemon restart with its exact bytes and chosen mode", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-html-"));
  const path = join(home, "store.sqlite");
  let store = new Store(path);
  let context: ContextService | undefined;
  let mcp: Awaited<ReturnType<typeof startDaemonMcp>> | undefined;
  try {
    const workspace = store.createWorkspace(home, "Test");
    const thread = createDevThread(store, workspace);
    const agent = Agent.parse({
      id: "root",
      threadId: thread.id,
      parentId: null,
      origin: "root",
      native: { provider: "codex" },
      fidelity: "full",
      cwd: home,
      status: { state: "idle" },
      createdAt: 1,
    });
    store.appendEvents(thread.id, [{ type: "agent.created", agent }], 1);
    const openContext = () =>
      ContextService.open({
        root: join(home, "context"),
        now: () => 2,
        id: randomUUID,
        authorize: () => true,
        workspace: () => undefined,
        threadExists: (id) => store.hasLiveThread(ThreadId.parse(id)),
        retained: (id, hash) => retainsHtml(store, id, hash),
      });
    context = await openContext();
    mcp = await startDaemonMcp(store, [
      htmlPublication({ store, context: () => context, now: () => 2, id: randomUUID }),
    ]);
    const lease = mcp.openSession(
      { sessionId: "html-test", threadId: thread.id, agentId: agent.id, capabilities: [] },
      new AbortController().signal,
    );
    const connection = { url: mcp.url, bearer: lease.bearer };
    // Exceeds the ordinary MCP input cap; payload remains outside transcript events.
    const html = `<!doctype html><html><body><h1>Replay</h1><!--${"é".repeat(40000)}--></body></html>`;
    const preview = Result.parse(
      await (await invoke(connection, "ace_html_preview", { html })).json(),
    );
    expect(preview.result.isError).not.toBe(true);
    expect(store.readItemPage(thread.id, store.headSeq() + 1, 200).items).toHaveLength(0);
    const rendered = Result.parse(
      await (
        await invoke(connection, "ace_html_render", {
          title: "Replay reader@example.invalid",
          html,
          height: 400,
        })
      ).json(),
    );
    expect(rendered.result.isError).not.toBe(true);
    const scripted = `<!doctype html><html><body><input type="range"><script>draw()</script></body></html>`;
    for (const args of [
      { title: "Slider", html: scripted },
      { title: "Chart", html: scripted, mode: "static" },
    ])
      expect(
        Result.parse(await (await invoke(connection, "ace_html_render", args)).json()).result
          .isError,
      ).not.toBe(true);
    const modes = () =>
      store
        .readItemPage(thread.id, store.headSeq() + 1, 200)
        .items.flatMap((entry) =>
          entry.type === "html" ? [[entry.visualization.title, entry.visualization.mode]] : [],
        );
    const published = [
      ["Replay <EMAIL>", "static"],
      ["Slider", "interactive"],
      ["Chart", "static"],
    ];
    expect(modes()).toEqual(published);
    const before = store.readItemPage(thread.id, store.headSeq() + 1, 200).items;
    const item = before.find((entry) => entry.type === "html");
    if (item?.type !== "html") throw new Error("Missing visualization");
    expect(item.visualization.title).toBe("Replay <EMAIL>");
    expect(JSON.stringify(item).length).toBeLessThan(2048);
    expect(retainsHtml(store, thread.id, item.visualization.document.sha256)).toBe(true);
    await mcp.close();
    mcp = undefined;
    await context.close();
    context = undefined;
    store.close();
    store = new Store(path);
    context = await openContext();
    expect(store.readItemPage(thread.id, store.headSeq() + 1, 200).items).toEqual(before);
    expect(modes()).toEqual(published);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < item.visualization.document.bytes; offset += 65536) {
      const content = await context.readAttachment(
        "reader",
        thread.id,
        item.visualization.document.sha256,
        "original",
        offset,
        65536,
        () => true,
      );
      chunks.push(Buffer.from(content.data));
    }
    expect(Buffer.concat(chunks).equals(Buffer.from(html))).toBe(true);
  } finally {
    await mcp?.close();
    await context?.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
