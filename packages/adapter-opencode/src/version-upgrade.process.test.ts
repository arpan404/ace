import { expect, test } from "vitest";
import { discoverOpenCodeModels } from "./index.ts";
import { setup } from "./testing/v2-session.ts";
import { object } from "./data.ts";

const release = (version: string, env: Record<string, string> = {}) => ({
  discovery: { env: { ACE_TEST_RELEASE: `release-${version}`, ...env } },
});

test.each(["2.0.22", "2.0.26", "2.0.27"])(
  "%s recovers a dropped stream on its verified server generation",
  async (version) => {
    const h = await setup(release(version));
    await h.publish("session.execution.started");
    await h.control("/test/state", {
      active: { [h.session.nativeSessionId]: { type: "running" } },
    });
    const from = h.frames.length;
    const outcome = h.seen(
      (f) =>
        f.channel === "lifecycle" && ["resynced", "exited"].includes(String(object(f.data).type)),
      from,
    );
    await h.control("/test/drop", {});
    expect(object((await outcome).data).type).toBe("resynced");
    expect(h.projection.view.thread.status.state).toBe("working");
    await h.publish("session.execution.succeeded");
    expect(h.projection.view.thread.status.state).toBe("done");
    expect(h.exits).toEqual([]);
  },
);

test.each(["2.0.26", "2.0.27", "2.0.99"])(
  "OpenCode %s with the matching API contract starts and lists models",
  async (version) => {
    const h = await setup(release(version));
    const report = await discoverOpenCodeModels(h.options, "/one", new AbortController().signal);
    expect(report).toMatchObject({ location: { directory: "/one" }, data: expect.any(Array) });
  },
);

test("a patch release that drops an operation ace calls is refused, naming the version and operation", async () => {
  const failure = setup(release("2.0.27", { ACE_TEST_CONTRACT_CHANGE: "drop session.prompt" }));
  await expect(failure).rejects.toThrow(
    /OpenCode 2\.0\.27 changed the API ace uses \(session\.prompt is missing\)/,
  );
});

test("a patch release that moves an operation ace calls is refused, naming the old and new route", async () => {
  const failure = setup(release("2.0.28", { ACE_TEST_CONTRACT_CHANGE: "move session.interrupt" }));
  await expect(failure).rejects.toThrow(
    "OpenCode 2.0.28 changed the API ace uses (session.interrupt moved from POST /api/session/:sessionID/interrupt to POST /api/v3/session.interrupt)",
  );
});

test.each(["2.0.21", "2.1.0", "1.18.33"])(
  "OpenCode %s outside the supported range is refused with the installed and supported versions",
  async (version) => {
    await expect(setup(release(version))).rejects.toThrow(
      `OpenCode ${version} is installed; ace supports OpenCode 2.0.x, 2.0.22 or newer`,
    );
  },
);
