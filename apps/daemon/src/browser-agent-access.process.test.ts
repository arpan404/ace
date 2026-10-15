import { expect, it, onTestFinished } from "vitest";
import { FakeHeadless } from "@ace/browser/testing";
import type { AccessMode, Interaction } from "@ace/protocol";
import { invoke, Result } from "./browser-mcp-test-support.ts";
import { browserFixture } from "./browser-service-test-support.ts";
import { startDaemonMcp } from "./mcp.ts";
import { browserToolkit } from "./browser-toolkit.ts";

/** Real daemon services and MCP over a fake headless backend: no external request leaves. */
async function agentBrowser(mode: AccessMode) {
  const f = await browserFixture(mode, undefined, new FakeHeadless());
  const mcp = await startDaemonMcp(f.store, [browserToolkit(f.browser, f.store)]);
  onTestFinished(() => mcp.close());
  const root = f.store.getThread(f.thread.id)?.rootAgentId;
  if (!root) throw new Error("Missing root agent");
  const lease = mcp.openSession(
    { sessionId: "agent-browser", threadId: f.thread.id, agentId: root, capabilities: ["browser"] },
    new AbortController().signal,
  );
  onTestFinished(() => lease.end());
  const opened: Interaction[] = [];
  const asked = Promise.withResolvers<"asked">();
  const stop = f.store.subscribe((events) => {
    for (const event of events)
      if (event.payload.type === "interaction.opened") {
        const interaction = event.payload.interaction;
        opened.push(interaction);
        // A private takeover's hold is the person's control, not a question to answer.
        if (!interaction.raw.some((raw) => raw.type === "ace.browser.private"))
          asked.resolve("asked");
      }
  });
  onTestFinished(stop);
  const call = async (name: string, args: unknown) => {
    const response = invoke({ url: mcp.url, bearer: lease.bearer }, name, args);
    // A tool that stops to ask a person never answers by itself; report the question instead.
    const first = await Promise.race([response, asked.promise]);
    if (first === "asked") return "asked" as const;
    return Result.parse(await first.json()).result;
  };
  return { ...f, call, opened };
}
function succeeded(result: Awaited<ReturnType<Awaited<ReturnType<typeof agentBrowser>>["call"]>>) {
  if (result === "asked") throw new Error("The tool waited for a person's approval");
  return result.isError !== true;
}

it.each(["ask", "auto-review"] as const)(
  "in %s, an agent opens, scripts and loads resources on a never-seen site without asking anyone",
  async (mode) => {
    const f = await agentBrowser(mode);
    expect(
      succeeded(await f.call("ace_browser_open", { url: "https://never-seen.example/page" })),
    ).toBe(true);
    expect(f.browser.state(f.thread.id).url).toBe("https://never-seen.example/page");
    expect(succeeded(await f.call("ace_browser_evaluate", { expression: "1 + 1" }))).toBe(true);
    const page = f.headless.opens[0];
    if (!page) throw new Error("Missing headless page");
    expect(await page.allowed("https://cdn.never-seen.example/app.js")).toBe(true);
    expect(await page.allowed("wss://socket.elsewhere.example/live")).toBe(true);
    expect(await page.allowed("file:///etc/passwd")).toBe(false);
    expect(f.opened).toEqual([]);
    expect(f.store.getThread(f.thread.id)?.status.state).not.toBe("needs_you");
  },
);

it("while a person holds the browser privately, agent navigation is refused until handback", async () => {
  const f = await agentBrowser("ask");
  f.browser.takeover(f.thread.id, "person", "private");
  const refused = await f.call("ace_browser_navigate", { url: "https://elsewhere.example/" });
  expect(refused).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("human_private") }],
  });
  expect(f.browser.state(f.thread.id).url).not.toContain("elsewhere.example");
  const hold = f.opened.find((interaction) =>
    interaction.raw.some((raw) => raw.type === "ace.browser.private"),
  );
  if (!hold) throw new Error("Private hold missing");
  expect(f.resolve(hold, "allow_once")).toMatchObject({
    ok: false,
    error: "private_handback_required",
  });
  expect(
    succeeded(await f.call("ace_browser_navigate", { url: "https://elsewhere.example/" })),
  ).toBe(false);
  f.browser.handback(f.thread.id, "person");
  expect(
    succeeded(await f.call("ace_browser_navigate", { url: "https://elsewhere.example/" })),
  ).toBe(true);
  expect(f.browser.state(f.thread.id).url).toBe("https://elsewhere.example/");
});
