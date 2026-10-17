import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { detectChromium } from "@ace/browser";
import { Agent, AgentId } from "@ace/protocol";
import { providerFeatures } from "./testing/provider-features.ts";
import { createDevThread } from "./commands.ts";

/** The ref on the snapshot line naming `name`, e.g. `- button "Save" [ref=e1-4]`. */
function ref(text: string, name: string) {
  const line = text.split("\n").find((entry) => entry.includes(`"${name}"`));
  const value = line?.match(/\[ref=([^\]]+)\]/)?.[1];
  if (!value) throw new Error(`Missing ref: ${name}`);
  return value;
}
import { invoke, Result } from "./browser-mcp-test-support.ts";

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
  /** browser_snapshot answers in text lines such as `- button "Save" [ref=e1-12]`. */
  async function snapshot(): Promise<string> {
    const result = Result.parse(
      await (await invoke(connection, "browser_snapshot", {})).json(),
    ).result;
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.content.map((part) => part.text).join("\n");
  }
  await call("browser_open", { url: f.browserUrl });
  const initial = await snapshot();
  const input = ref(initial, "Name"),
    submit = ref(initial, "Submit");
  await call("browser_act", { action: "click", ref: input });
  await call("browser_act", { action: "type", ref: input, text: "journey" });
  expect(ref(await snapshot(), "Name")).toBe(input);
  await call("browser_act", { action: "press", ref: input, key: "Tab" });
  await call("browser_act", { action: "click", ref: submit });
  expect(await submitted.promise).toBe("journey");
  const waiting = call("browser_wait_for", { url: `${f.browserUrl}/result?name=journey` });
  release.resolve();
  await waiting;
  await call("browser_wait_for", { text: "Saved journey" });
  expect(await snapshot()).toMatch(/- heading "Saved journey"/);
  const stale = Result.parse(
    await (await invoke(connection, "browser_act", { action: "click", ref: submit })).json(),
  ).result;
  expect(stale).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("stale_ref") }],
  });
  const invalidWait = Result.parse(
    await (
      await invoke(connection, "browser_wait_for", { url: f.browserUrl, text: "Saved" })
    ).json(),
  ).result;
  expect(invalidWait).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("invalid_arguments") }],
  });
  const timeout = Result.parse(
    await (
      await invoke(connection, "browser_wait_for", { text: "Absent result", timeout: 50 })
    ).json(),
  ).result;
  expect(timeout).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("timed out") }],
  });
  await call("browser_settings", {
    action: "emulate",
    width: 2000,
    height: 1000,
    deviceScaleFactor: 2,
  });
  const screenshot = image.parse(await (await invoke(connection, "browser_screenshot", {})).json())
    .result.content[0];
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
  expect(await call("browser_evaluate", { expression: "window.innerWidth" })).toBe(2000);
  expect(await call("browser_logs")).toMatchObject({ entries: expect.any(Array) });
  const browser = f.daemon.browser;
  if (!browser) throw new Error("Browser missing");
  browser.takeover(thread.id, "person");
  expect(
    Result.parse(await (await invoke(connection, "browser_settings", { action: "close" })).json())
      .result,
  ).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("controlled by human") }],
  });
  expect(
    Result.parse(await (await invoke(connection, "browser_open", { url: f.browserUrl })).json())
      .result,
  ).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("controlled by human") }],
  });
  browser.handback(thread.id, "person");
  await call("browser_open", { url: f.browserUrl });
  await call("browser_settings", { action: "close" });
  lease.end();
  expect((await invoke(connection, "browser_open", {})).status).toBe(401);
});
