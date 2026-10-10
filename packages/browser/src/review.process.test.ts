import { createServer, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { executablePath, fixture, ref } from "./test-support.ts";

const noop = () => {};

describe.skipIf(!executablePath)("browser review regressions", () => {
  it("human editing and navigation keys change the focused input", async () => {
    const f = await fixture();
    await f.navigate();
    const name = ref(await f.execute({ action: "snapshot" }), "Name");
    await f.execute({ action: "type", ref: name, text: "abc" });
    f.service.takeover("thread", "owner");
    const press = async (key: string, code = key) => {
      for (const event of ["keyDown", "keyUp"])
        await f.service.input("thread", { kind: "key", event, key, code }, "owner");
    };
    const value = () =>
      f.service.execute(
        "thread",
        {
          action: "evaluate",
          expression: "document.querySelector('input').value",
        },
        { kind: "human", connectionId: "owner" },
      );
    await press("End");
    await press("Backspace");
    expect(await value()).toBe("ab");
    await press("Home");
    await press("Delete");
    expect(await value()).toBe("b");
    await press("ArrowRight");
    await press("Backspace");
    expect(await value()).toBe("");
    await press("x", "KeyX");
    expect(await value()).toBe("x");
    await expect(
      f.service.input(
        "thread",
        { kind: "key", event: "keyDown", key: "Backspace", code: "KeyA" },
        "owner",
      ),
    ).rejects.toThrow("key/code mismatch");
    expect(await value()).toBe("x");
    await f.service.input(
      "thread",
      { kind: "key", event: "char", key: "Unidentified", text: "👩‍💻" },
      "owner",
    );
    expect(await value()).toBe("x👩‍💻");
    await press("Tab");
    expect(
      await f.service.execute(
        "thread",
        { action: "evaluate", expression: "document.activeElement.textContent" },
        { kind: "human", connectionId: "owner" },
      ),
    ).toBe("Save");
  }, 60_000);

  it("queues a socket burst and cancels queued approvals on shutdown", async () => {
    const full = Promise.withResolvers<void>();
    let approvals = 0;
    const pending = Promise.withResolvers<boolean>();
    const f = await fixture({
      originPolicy: () => {
        if (++approvals === 32) full.resolve();
        return pending.promise;
      },
    });
    await f.navigate();
    const socketUrl = JSON.stringify(
      f.url.replace("http:", "ws:").replace("127.0.0.1", "127.0.0.2"),
    );
    await f.evaluate(`for(let i=0;i<40;i++) new WebSocket(${socketUrl}+'/'+i); void 0`);
    await full.promise;
    await f.service.open({ threadId: "other", workspaceId: "other" });
    const navigation = f.service.execute("other", {
      action: "navigate",
      url: "https://example.invalid",
    });
    const cancelled = expect(navigation).rejects.toThrow(/shutting down|abort|closed/i);
    await f.service.close();
    await cancelled;
    expect(approvals).toBe(32);
    pending.resolve(false);
    expect(() => f.service.state("thread")).toThrow("not open");
  });

  it("cancels only the closing thread's pending approval", async () => {
    const { promise: entered, resolve: notify } = Promise.withResolvers<void>();
    const { promise: pending } = Promise.withResolvers<boolean>();
    const aborted = Promise.withResolvers<void>();
    const f = await fixture({
      evaluatePolicy: (threadId, _url, signal) => {
        if (threadId !== "thread") return true;
        signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
        notify();
        return pending;
      },
    });
    await f.service.open({ threadId: "other", workspaceId: "other" });
    const failure = expect(f.evaluate("1")).rejects.toThrow("shutting down");
    await entered;
    await Promise.all([f.service.closeThread("thread"), failure, aborted.promise]);
    expect(await f.service.execute("other", { action: "evaluate", expression: "2+2" })).toBe(4);
  }, 60_000);

  it("rolls back a subscription whose initial state callback throws", async () => {
    const f = await fixture();
    for (let i = 0; i < 64; i++)
      expect(() =>
        f.service.subscribe("thread", String(i), { send: () => true }, () => {
          throw new Error("viewer failed");
        }),
      ).toThrow("viewer failed");
    let received = false;
    let stop = noop;
    expect(() => {
      stop = f.service.subscribe(
        "thread",
        "healthy",
        {
          send: () => {
            received = true;
            return true;
          },
        },
        () => {},
      );
    }).not.toThrow();
    expect(received).toBe(true);
    stop();
  }, 60_000);

  it("limits evaluate results in UTF-8 bytes", async () => {
    const f = await fixture();
    expect(await f.evaluate("'😀'.repeat(1000)")).toBe("😀".repeat(1000));
    await expect(f.evaluate("'😀'.repeat(130000)")).rejects.toThrow("evaluate failed");
  }, 60_000);

  it("bounds evaluation output when page code replaces encoding and parsing builtins", async () => {
    const f = await fixture();
    await f.evaluate(
      "globalThis.TextEncoder=class{encode(){return new Uint8Array(0)}}; JSON.parse=()=> '😀'.repeat(130000); String.prototype.charCodeAt=()=>0; void 0",
    );
    expect(await f.evaluate("'safe' ")).toBe("safe");
    await expect(f.evaluate("'😀'.repeat(130000)")).rejects.toThrow("evaluate failed");
  }, 60_000);

  it("bounds evaluation output when the expression itself replaces the encoder", async () => {
    const f = await fixture();
    await expect(
      f.evaluate(
        "globalThis.TextEncoder=class{encode(){return new Uint8Array(0)}}; '😀'.repeat(130000)",
      ),
    ).rejects.toThrow("evaluate failed");
  }, 60_000);

  it("rejects a snapshot of an oversized DOM before building its accessibility tree", async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate(
      "const fragment=document.createDocumentFragment();for(let i=0;i<21000;i++)fragment.append(document.createElement('span'));document.body.append(fragment)",
    );
    await expect(f.execute({ action: "snapshot" })).rejects.toThrow("snapshot node limit");
  }, 60_000);

  it("rejects excess commands while preserving admitted commands", async () => {
    const { promise: entered, resolve: notify } = Promise.withResolvers<void>();
    const { promise: pending, resolve: release } = Promise.withResolvers<boolean>();
    const f = await fixture({
      evaluatePolicy: () => {
        notify();
        return pending;
      },
    });
    const active = f.evaluate("42");
    await entered;
    const queued = Array.from({ length: 31 }, (_, index) => f.evaluate(String(index)));
    const excess = expect(f.execute({ action: "snapshot" })).rejects.toThrow("queue full");
    release(true);
    await excess;
    expect(await active).toBe(42);
    expect(await Promise.all(queued)).toEqual(Array.from({ length: 31 }, (_, index) => index));
  }, 60_000);

  it("waits for a delayed visibility transition and rejects an unmet visibility deadline", async () => {
    const f = await fixture();
    await f.navigate();
    const name = ref(await f.execute({ action: "snapshot" }), "Name");
    await f.evaluate("document.querySelector('input').style.visibility='hidden'");
    await expect(
      f.execute({ action: "wait_for", ref: name, state: "visible", timeout: 30 }),
    ).rejects.toThrow();
    const held = Promise.withResolvers<ServerResponse>();
    const measured = Promise.withResolvers<void>();
    const server = createServer((request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      if (request.url === "/measure") {
        measured.resolve();
        response.end();
      } else held.resolve(response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No transition server");
    let response: ServerResponse | undefined;
    try {
      await f.evaluate(
        `const element=document.querySelector('input');
         const rectangle=element.getBoundingClientRect.bind(element); let reported=false;
         element.getBoundingClientRect=()=>{if(!reported){reported=true;fetch('http://127.0.0.1:${address.port}/measure')}return rectangle()};
         fetch('http://127.0.0.1:${address.port}/transition').then(()=>{element.style.visibility='visible'});void 0`,
      );
      response = await held.promise;
      const waiting = f.execute({ action: "wait_for", ref: name, state: "visible" });
      // The page reports a rectangle measurement by the pending wait itself.
      // A painted frame alone would not establish that the command dispatched.
      expect(
        await Promise.race([
          waiting.then(() => "returned before hidden measurement"),
          measured.promise.then(() => "measured while hidden"),
        ]),
      ).toBe("measured while hidden");
      response.end();
      await waiting;
      expect(await f.evaluate("getComputedStyle(document.querySelector('input')).visibility")).toBe(
        "visible",
      );
    } finally {
      response?.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});
