import { z } from "zod";
import { expect, it } from "vitest";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { browserToolkit } from "./index.ts";
import { backendFixture } from "./backend-test-support.ts";
import { TestNavigationClock } from "./navigation-test-clock.ts";

it("takeover and handback invalidate both queued and resolving agent input", async () => {
  const f = await backendFixture({ backendPreference: () => "headless" });
  await f.open();
  const raw = await f.service.execute("thread", { action: "snapshot" });
  const snapshot = z
    .object({ nodes: z.array(z.object({ ref: z.string().optional() })) })
    .parse(raw);
  const ref = snapshot.nodes[0]?.ref;
  if (!ref) throw new Error("Missing ref");
  const page = f.headless.pages[0];
  if (!page) throw new Error("Missing page");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const send = page.cdp.send;
  page.cdp.send = async (method, params) => {
    if (method === "Runtime.callFunctionOn") {
      entered.resolve();
      await release.promise;
    }
    return send(method, params);
  };
  const first = f.service.execute("thread", { action: "type", ref, text: "in-flight" });
  const rejectedFirst = expect(first).rejects.toMatchObject({ code: "controller_changed" });
  await entered.promise;
  const second = f.service.execute("thread", { action: "type", ref, text: "queued" });
  const rejectedSecond = expect(second).rejects.toMatchObject({ code: "controller_changed" });
  f.service.takeover("thread", "person");
  f.service.handback("thread", "person");
  release.resolve();
  await rejectedFirst;
  await rejectedSecond;
  expect(page.text).toBe("");
  await f.service.execute("thread", { action: "type", ref, text: "fresh" });
  expect(page.text).toBe("fresh");
});

it.each(["URL", "element"])(
  "a %s wait submitted after a click's policy check started retains its load budget through approval",
  async (condition) => {
    const clock = new TestNavigationClock();
    const entered = Promise.withResolvers<void>();
    const approval = Promise.withResolvers<boolean>();
    const polling = Promise.withResolvers<void>();
    let loaded = false;
    const f = await backendFixture({
      backendPreference: () => "headless",
      navigationClock: clock,
      origins: { list: () => [], grant() {}, revoke() {} },
      originPolicy: () => {
        entered.resolve();
        return approval.promise;
      },
    });
    await f.open();
    const snapshot = z
      .object({ nodes: z.array(z.object({ ref: z.string().optional() })) })
      .parse(await f.service.execute("thread", { action: "snapshot" }));
    const ref = snapshot.nodes[0]?.ref;
    if (!ref) throw new Error("Missing ref");
    const page = f.headless.pages[0],
      backend = f.headless.opens[0];
    if (!page || !backend) throw new Error("Missing backend");
    const send = page.cdp.send;
    page.cdp.send = async (method, params) => {
      if (method === "Runtime.evaluate" || method === "Runtime.callFunctionOn") {
        polling.resolve();
        return { result: { value: loaded } };
      }
      return send(method, params);
    };
    const policy = backend.allowed("https://journey.invalid/result", { navigation: true });
    await entered.promise;
    const registry = new ToolRegistry({
      scheduler: { after: (delay, work) => clock.set(delay, work) },
    });
    browserToolkit(f.service).register(registry);
    const lease = new CredentialRegistry(() => "a".repeat(64)).issue(
      McpScope.parse({
        sessionId: "wait",
        threadId: "thread",
        agentId: "root",
        capabilities: ["browser"],
      }),
      new AbortController().signal,
    );
    try {
      const waiting = registry.call(
        "ace_browser_wait_for",
        condition === "URL" ? { url: "https://journey.invalid/result" } : { ref, state: "visible" },
        lease.principal,
        new AbortController().signal,
      );
      await polling.promise;
      clock.advance(60_000);
      approval.resolve(true);
      expect(await policy).toBe(true);
      loaded = true;
      clock.advance(50);
      expect(await waiting).not.toHaveProperty("isError", true);
    } finally {
      lease.end();
    }
  },
);

it("cancelling an element wait frees the browser queue for the next command", async () => {
  const clock = new TestNavigationClock();
  const f = await backendFixture({ backendPreference: () => "headless", navigationClock: clock });
  await f.open();
  const snapshot = z
    .object({ nodes: z.array(z.object({ ref: z.string().optional() })) })
    .parse(await f.service.execute("thread", { action: "snapshot" }));
  const ref = snapshot.nodes[0]?.ref;
  const page = f.headless.pages[0];
  if (!ref || !page) throw new Error("Missing page ref");
  const measured = Promise.withResolvers<void>();
  const send = page.cdp.send;
  page.cdp.send = async (method, params) => {
    if (method === "Runtime.callFunctionOn") {
      measured.resolve();
      return { result: { value: false } };
    }
    return send(method, params);
  };
  const abort = new AbortController();
  const waiting = f.service.execute(
    "thread",
    { action: "wait_for", ref, state: "visible" },
    { kind: "agent" },
    abort.signal,
  );
  const cancelled = expect(waiting).rejects.toThrow("Agent cancelled wait");
  await measured.promise;
  abort.abort(new Error("Agent cancelled wait"));
  await cancelled;
  await f.service.execute("thread", { action: "press", key: "Enter" });
  expect(f.service.state("thread").status).toBe("ready");
});
