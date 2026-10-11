import { expect, test } from "vitest";
import { discoverOpenCodeModels } from "./index.ts";
import { setup } from "./testing/v2-session.ts";
import { object } from "./data.ts";

test.each(["2.0.22", "2.0.26"])(
  "%s recovers a dropped stream on its verified server generation",
  async (version) => {
    const h = await setup({
      discovery: { env: { ACE_TEST_OPENCODE_VERSION: version, ACE_TEST_SERVER_VERSION: version } },
    });
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

test("the reviewed OpenCode 2.0.26 patch can list models with matching server identity and API contract", async () => {
  const h = await setup({
    discovery: {
      env: {
        ACE_TEST_OPENCODE_VERSION: "2.0.26",
        ACE_TEST_SERVER_VERSION: "2.0.26",
      },
    },
  });
  const report = await discoverOpenCodeModels(h.options, "/one", new AbortController().signal);
  expect(report).toMatchObject({ location: { directory: "/one" }, data: expect.any(Array) });
});
