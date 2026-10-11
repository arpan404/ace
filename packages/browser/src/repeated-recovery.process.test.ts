import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { BrowserFrame } from "@ace/protocol";
import { backendFixture, FakeHeadless } from "./backend-test-support.ts";

it("ordinary agent opens recover after repeated losses of the replacement headless page and release old profiles", async () => {
  const f = await backendFixture({ backendLoss: () => "headless" });
  await f.open();
  await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/page" });
  const ready = Promise.withResolvers<void>();
  const frames: BrowserFrame[] = [];
  f.service.subscribe(
    "thread",
    "viewer",
    {
      send: (frame) => {
        frames.push(frame);
        f.service.acknowledge("thread", "viewer", frame.sequence);
        return true;
      },
    },
    (state) => {
      if (state.backend === "headless" && state.status === "ready") ready.resolve();
    },
  );
  await f.disconnect();
  await ready.promise;
  for (let count = 0; count < 2; count++) {
    const lost = f.headless.opens.at(-1);
    if (!lost) throw new Error("Missing replacement");
    lost.lost("Headless context closed");
    expect(f.service.state("thread")).toMatchObject({ status: "paused", closed: false });
    expect(
      await f.service.open({
        threadId: "thread",
        workspaceId: "workspace-thread",
        background: true,
      }),
    ).toMatchObject({ backend: "headless", status: "ready", url: "http://localhost:3000/page" });
    await f.service.execute("thread", { action: "press", key: "Enter" });
    // Late traffic from the retired page cannot suspend the new page.
    lost.lost("Late context close");
    expect(f.service.state("thread").status).toBe("ready");
    expect(
      (await readdir(join(f.home, "browser"))).filter((name) => name.startsWith("recovery-")),
    ).toHaveLength(1);
  }
  expect(frames.length).toBeGreaterThanOrEqual(4);
  await f.service.closeThread("thread");
  expect(
    (await readdir(join(f.home, "browser"))).filter((name) => name.startsWith("recovery-")),
  ).toEqual([]);
});

it.each(["shared", "private"] as const)(
  "replacement loss retains %s ownership until an explicit human open",
  async (mode) => {
    const f = await backendFixture({ backendLoss: () => "headless" });
    await f.open();
    f.service.takeover("thread", "owner", mode);
    const ready = Promise.withResolvers<void>();
    f.service.subscribe("thread", "owner", { send: () => true }, (state) => {
      if (state.backend === "headless" && state.status === "ready") ready.resolve();
    });
    await f.disconnect();
    await ready.promise;
    f.headless.opens.at(-1)?.lost("Headless context closed");
    expect(
      await f.service.open({
        threadId: "thread",
        workspaceId: "workspace-thread",
        background: true,
      }),
    ).toMatchObject({ status: "paused", owner: "owner", takeoverMode: mode });
    expect(await f.open()).toMatchObject({
      status: "ready",
      controller: "human",
      owner: "owner",
      takeoverMode: mode,
    });
    await expect(f.service.execute("thread", { action: "press", key: "Enter" })).rejects.toThrow(
      mode === "private" ? "private while a human has control" : "controlled by human",
    );
    await f.service.input("thread", { kind: "key", event: "char", key: "x" }, "owner");
    expect(f.headless.pages.at(-1)?.text).toBe("x");
  },
);

it.each(["open", "controller"])(
  "headless loss during replacement %s never publishes a dead page as ready and can retry",
  async (phase) => {
    const headless = new FakeHeadless();
    const open = headless.open.bind(headless);
    let fail = true;
    headless.open = async (request) => {
      const backend = await open(request);
      if (fail && phase === "open") request.lost("Replacement closed during startup");
      if (fail && phase === "controller")
        return {
          ...backend,
          controller: async () => {
            request.lost("Replacement closed during controller setup");
          },
        };
      return backend;
    };
    const errors = Promise.withResolvers<void>();
    const f = await backendFixture({ headlessBackend: headless, onError: () => errors.resolve() });
    await f.open();
    await f.disconnect();
    const ready: string[] = [];
    f.service.subscribe("thread", "viewer", { send: () => true }, (state) => {
      if (state.status === "ready") ready.push(state.url);
    });
    await f.service.open({ threadId: "thread", workspaceId: "workspace-thread", background: true });
    // The startup error is exposed as a paused retryable session.
    expect(f.service.state("thread")).toMatchObject({ status: "paused", closed: false });
    expect(ready).toEqual([]);
    await errors.promise;
    fail = false;
    expect(
      await f.service.open({
        threadId: "thread",
        workspaceId: "workspace-thread",
        background: true,
      }),
    ).toMatchObject({ status: "ready", backend: "headless" });
    await f.service.execute("thread", { action: "press", key: "Enter" });
  },
);
