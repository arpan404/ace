import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { detectChromium } from "@ace/browser";
import { FakeHeadless } from "@ace/browser/testing";
import { Agent, AgentId, type PermissionMode } from "@ace/protocol";
import { providerFeatures } from "./testing/provider-features.ts";
import { createDevThread } from "./commands.ts";
import { invoke, Result } from "./browser-mcp-test-support.ts";
import { originFixture } from "./browser-origin-test-support.ts";
import { startDaemonMcp } from "./mcp.ts";
import { browserToolkit } from "./browser-toolkit.ts";

const nodes = z.object({
  nodes: z.array(z.object({ name: z.string(), ref: z.string().optional() })),
});
const image = z.object({
  result: z.object({ content: z.array(z.object({ type: z.literal("image"), data: z.string() })) }),
});

it("an agent completes a form navigation, reads results, rejects stale refs and resumes after human control", async (test) => {
  const chromium = await detectChromium();
  if (!chromium) {
    test.skip("Chromium is not installed; this journey never downloads it");
    return;
  }
  const home = await mkdtemp(join(tmpdir(), "ace-agent-journey-"));
  const submitted = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  const f = await providerFeatures(home, chromium, async (request, response) => {
    response.setHeader("Content-Type", "text/html");
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/result") {
      submitted.resolve(url.searchParams.get("name") ?? "");
      await release.promise;
      response.end('<!doctype html><h1>Saved journey</h1><a href="/">Back</a>');
    } else
      response.end(
        '<!doctype html><form action="/result"><label>Name <input name="name" aria-label="Name"></label><button>Submit</button></form>',
      );
  });
  onTestFinished(async () => {
    release.resolve();
    try {
      await f.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  const workspace = f.daemon.store.createWorkspace(home, "Journey");
  const thread = createDevThread(f.daemon.store, workspace);
  f.daemon.store.appendEvents(thread.id, [
    {
      type: "agent.created",
      agent: Agent.parse({
        id: "root",
        threadId: thread.id,
        parentId: null,
        origin: "root",
        native: { provider: "codex" },
        fidelity: "full",
        cwd: home,
        status: { state: "working", activity: "tool" },
        createdAt: 1,
      }),
    },
  ]);
  const lease = f.daemon.mcp.openSession(
    {
      sessionId: "journey",
      threadId: thread.id,
      agentId: AgentId.parse("root"),
      capabilities: ["browser"],
    },
    new AbortController().signal,
  );
  const connection = { url: f.daemon.mcp.url, bearer: lease.bearer };
  async function call(name: string, args: unknown = {}) {
    const result = Result.parse(await (await invoke(connection, name, args)).json()).result;
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return JSON.parse(result.content[0]?.text ?? "null");
  }
  function ref(snapshot: unknown, name: string) {
    const value = nodes.parse(snapshot).nodes.find((node) => node.name === name)?.ref;
    if (!value) throw new Error(`Missing ref: ${name}`);
    return value;
  }
  await call("ace_browser_open", { url: f.browserUrl });
  const initial = await call("ace_browser_snapshot");
  const input = ref(initial, "Name"),
    submit = ref(initial, "Submit");
  await call("ace_browser_click", { ref: input });
  await call("ace_browser_type", { ref: input, text: "journey" });
  expect(ref(await call("ace_browser_snapshot"), "Name")).toBe(input);
  await call("ace_browser_press", { ref: input, key: "Tab" });
  await call("ace_browser_click", { ref: submit });
  expect(await submitted.promise).toBe("journey");
  const waiting = call("ace_browser_wait_for", { url: `${f.browserUrl}/result?name=journey` });
  release.resolve();
  await waiting;
  await call("ace_browser_wait_for", { text: "Saved journey" });
  expect(
    nodes
      .parse(await call("ace_browser_snapshot"))
      .nodes.some((node) => node.name === "Saved journey"),
  ).toBe(true);
  const stale = Result.parse(
    await (await invoke(connection, "ace_browser_click", { ref: submit })).json(),
  ).result;
  expect(stale).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("stale_ref") }],
  });
  const invalidWait = Result.parse(
    await (
      await invoke(connection, "ace_browser_wait_for", { url: f.browserUrl, text: "Saved" })
    ).json(),
  ).result;
  expect(invalidWait).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("invalid_arguments") }],
  });
  const timeout = Result.parse(
    await (
      await invoke(connection, "ace_browser_wait_for", { text: "Absent result", timeout: 50 })
    ).json(),
  ).result;
  expect(timeout).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("timed out") }],
  });
  await call("ace_browser_emulate", { width: 2000, height: 1000, deviceScaleFactor: 2 });
  const screenshot = image.parse(
    await (await invoke(connection, "ace_browser_screenshot", {})).json(),
  ).result.content[0];
  if (!screenshot) throw new Error("Missing image");
  const bytes = Buffer.from(screenshot.data, "base64");
  expect(bytes.readUInt16BE(0)).toBe(0xffd8);
  // JPEG SOF markers carry the encoded dimensions, independent of the viewport.
  let offset = 2,
    dimensions: number[] = [];
  while (offset < bytes.length) {
    const marker = bytes.readUInt16BE(offset);
    offset += 2;
    const length = bytes.readUInt16BE(offset);
    if ([0xffc0, 0xffc1, 0xffc2].includes(marker)) {
      dimensions = [bytes.readUInt16BE(offset + 3), bytes.readUInt16BE(offset + 5)];
      break;
    }
    offset += length;
  }
  expect(dimensions).toHaveLength(2);
  expect(Math.max(...dimensions)).toBeLessThanOrEqual(1536);
  expect(await call("ace_browser_evaluate", { expression: "window.innerWidth" })).toBe(2000);
  expect(await call("ace_browser_logs")).toMatchObject({ entries: expect.any(Array) });
  const browser = f.daemon.browser;
  if (!browser) throw new Error("Browser missing");
  browser.takeover(thread.id, "person");
  expect(
    Result.parse(await (await invoke(connection, "ace_browser_close", {})).json()).result,
  ).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("controlled by human") }],
  });
  expect(
    Result.parse(
      await (await invoke(connection, "ace_browser_navigate", { url: f.browserUrl })).json(),
    ).result,
  ).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("controlled by human") }],
  });
  browser.handback(thread.id, "person");
  await call("ace_browser_navigate", { url: f.browserUrl });
  await call("ace_browser_close");
  lease.end();
  expect((await invoke(connection, "ace_browser_open", {})).status).toBe(401);
});

it.each(["ask", "auto-review", "read-only", "full-access"] satisfies PermissionMode[])(
  "%s reports origin decisions through real daemon MCP without external requests",
  async (mode) => {
    const f = await originFixture(mode, undefined, new FakeHeadless());
    const mcp = await startDaemonMcp(f.store, [browserToolkit(f.browser, f.store)]);
    onTestFinished(() => mcp.close());
    const root = f.store.getThread(f.thread.id)?.rootAgentId;
    if (!root) throw new Error("Missing root");
    const lease = mcp.openSession(
      {
        sessionId: "origin-journey",
        threadId: f.thread.id,
        agentId: root,
        capabilities: ["browser"],
      },
      new AbortController().signal,
    );
    const opened = mode === "ask" || mode === "auto-review" ? f.opened() : undefined;
    const call = invoke({ url: mcp.url, bearer: lease.bearer }, "ace_browser_open", {
      url: "https://journey.invalid/",
    });
    if (opened) {
      const approval = await opened;
      expect(f.store.getInteraction(approval.id)?.state).toBe("pending");
      expect(f.resolve(approval, "deny").ok).toBe(true);
    }
    const result = Result.parse(await (await call).json()).result;
    if (mode === "full-access") expect(result.isError).not.toBe(true);
    else
      expect(result).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining(mode === "read-only" ? "read_only" : "denied") }],
      });
    lease.end();
  },
);
