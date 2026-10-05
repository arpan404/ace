import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { readdir } from "node:fs/promises";
import { backendFixture, FakeHeadless } from "./backend-test-support.ts";

async function pageFixture() {
  const f = await backendFixture({ backendPreference: () => "headless" });
  await f.open();
  const snapshot = z
    .object({ nodes: z.array(z.object({ ref: z.string().optional() })) })
    .parse(await f.service.execute("thread", { action: "snapshot" }));
  const ref = snapshot.nodes[0]?.ref;
  const page = f.headless.pages[0];
  const backend = f.headless.opens[0];
  if (!ref || !page || !backend) throw new Error("Missing page");
  return { ...f, ref, page, backend };
}
const actions = ["click", "type", "press"] as const;
function command(action: (typeof actions)[number], ref: string) {
  return action === "type"
    ? { action, ref, text: "forbidden" }
    : action === "press"
      ? { action, ref, key: "Enter" }
      : { action, ref };
}

it.each(actions)(
  "%s does not prepare or dispatch input when takeover happens during node resolution",
  async (action) => {
    const f = await pageFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    onTestFinished(() => release.resolve());
    const send = f.page.cdp.send;
    f.page.cdp.send = async (method, params) => {
      if (method === "DOM.resolveNode") {
        entered.resolve();
        await release.promise;
      }
      return send(method, params);
    };
    const rejected = expect(
      f.service.execute("thread", command(action, f.ref)),
    ).rejects.toMatchObject({ code: "controller_changed" });
    await entered.promise;
    f.service.takeover("thread", "person");
    f.service.handback("thread", "person");
    release.resolve();
    await rejected;
    expect(f.page.effects).toEqual([]);
    await f.service.execute("thread", command(action, f.ref));
    expect(f.page.effects.length).toBeGreaterThan(0);
  },
);

it.each(actions)(
  "%s does not prepare or dispatch input when aborted during node resolution",
  async (action) => {
    const f = await pageFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    onTestFinished(() => release.resolve());
    const send = f.page.cdp.send;
    f.page.cdp.send = async (method, params) => {
      if (method === "DOM.resolveNode") {
        entered.resolve();
        await release.promise;
      }
      return send(method, params);
    };
    const abort = new AbortController();
    const rejected = expect(
      f.service.execute("thread", command(action, f.ref), { kind: "agent" }, abort.signal),
    ).rejects.toThrow("cancelled preparation");
    await entered.promise;
    abort.abort(new Error("cancelled preparation"));
    release.resolve();
    await rejected;
    expect(f.page.effects).toEqual([]);
  },
);

it.each(["DOM.resolveNode", "Runtime.releaseObject"])(
  "navigation during %s prevents old refs from affecting the destination",
  async (barrier) => {
    for (const action of actions) {
      const f = await pageFixture();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      onTestFinished(() => release.resolve());
      const send = f.page.cdp.send;
      f.page.cdp.send = async (method, params) => {
        if (method === barrier) {
          entered.resolve();
          await release.promise;
        }
        return send(method, params);
      };
      const rejected = expect(
        f.service.execute("thread", command(action, f.ref)),
      ).rejects.toMatchObject({ code: "stale_ref" });
      await entered.promise;
      f.page.url = "http://localhost/destination";
      f.backend.navigation();
      f.page.effects.length = 0;
      release.resolve();
      await rejected;
      expect(f.page.effects).toEqual([]);
    }
  },
);

it.each(["hover", "drag", "select", "check", "uncheck", "focus"] as const)(
  "%s refuses a lease that changed during target resolution",
  async (action) => {
    const f = await pageFixture(),
      entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    onTestFinished(() => release.resolve());
    const send = f.page.cdp.send;
    f.page.cdp.send = async (method, params) => {
      if (method === "DOM.resolveNode") {
        entered.resolve();
        await release.promise;
      }
      return send(method, params);
    };
    const rejected = expect(
      f.service.execute("thread", {
        action,
        ref: f.ref,
        ...(action === "drag" ? { toRef: f.ref } : {}),
        ...(action === "select" ? { values: ["chosen"] } : {}),
      }),
    ).rejects.toMatchObject({ code: "controller_changed" });
    await entered.promise;
    f.service.takeover("thread", "person");
    f.service.handback("thread", "person");
    release.resolve();
    await rejected;
    expect(f.page.effects).toEqual([]);
    await f.service.execute("thread", { action: "type", ref: f.ref, text: "continued" });
    expect(f.page.text).toBe("continued");
  },
);
it("a snapshot started before private takeover cannot deliver private-period data after handback", async () => {
  const f = await pageFixture(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  onTestFinished(() => release.resolve());
  const send = f.page.cdp.send;
  f.page.cdp.send = async (method, params) => {
    if (method === "Accessibility.getFullAXTree") {
      entered.resolve();
      await release.promise;
    }
    return send(method, params);
  };
  const rejected = expect(
    f.service.execute("thread", { action: "snapshot" }),
  ).rejects.toMatchObject({ code: "human_private" });
  await entered.promise;
  f.service.takeover("thread", "person", "private");
  f.service.handback("thread", "person");
  release.resolve();
  await rejected;
  expect(
    z
      .object({ nodes: z.array(z.object({ name: z.string() })) })
      .parse(await f.service.execute("thread", { action: "snapshot" })).nodes[0]?.name,
  ).toBe("Name");
});

it.each(["screenshot", "recording"] as const)(
  "an interrupted %s never writes private frames after handback",
  async (action) => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    onTestFinished(() => release.resolve());
    const headless = new FakeHeadless(),
      open = headless.open.bind(headless);
    headless.open = async (request) => ({
      ...(await open(request)),
      screenshot: async () => {
        entered.resolve();
        await release.promise;
        return Buffer.from("private-image");
      },
    });
    const f = await backendFixture({
      backendPreference: () => "headless",
      headlessBackend: headless,
    });
    await f.open();
    const request =
      action === "screenshot"
        ? f.service.execute("thread", { action: "screenshot" })
        : f.service.startRecording("thread");
    const rejected = expect(request).rejects.toMatchObject({ code: "human_private" });
    await entered.promise;
    f.service.takeover("thread", "person", "private");
    f.service.handback("thread", "person");
    release.resolve();
    await rejected;
    expect(
      (await readdir(f.home, { recursive: true })).filter((path) => /\.(png|jpg)$/.test(path)),
    ).toEqual([]);
  },
);
