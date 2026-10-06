import { expect, test } from "vitest";
import { setup } from "./testing/v2-session.ts";
import { array, object } from "./data.ts";

test.each([
  ["auto-review", "ask"],
  ["ask", "ask"],
  ["read-only", "ask"],
  ["full-access", "allow"],
] as const)("%s configures OpenCode's permission gate before execution", async (mode, effect) => {
  const h = await setup();
  const session = await h.open("/two", undefined, mode);
  const requests = array(await h.control("/test/requests")).map(object);
  const create = requests.find(
    (request) =>
      request.path === "/api/session" && object(object(request.body).location).directory === "/two",
  );
  expect(object(create?.body).permissions).toEqual([{ action: "*", resource: "*", effect }]);
  await session.close("shutdown");
});

test.each(["ask", "auto-review"] as const)(
  "OpenCode %s reapplies the native ask rule when resuming an unrestricted session",
  async (mode) => {
    const h = await setup();
    // The scripted server is memory-only; h.session keeps this workspace's server alive.
    const source = await h.open("/one", undefined, "full-access");
    const native = source.nativeSessionId;
    await source.close("idle");
    const resumed = await h.open("/one", native, mode);
    try {
      const requests = array(await h.control("/test/requests")).map(object);
      const update = requests.find(
        (r) => r.path === `/api/session/${native}` && object(r.body).permissions !== undefined,
      );
      expect(object(update?.body).permissions).toEqual([
        { action: "*", resource: "*", effect: "ask" },
      ]);
      const restored = object(await h.control(`/api/session/${native}`));
      expect(object(restored.data).permissions).toEqual([
        { action: "*", resource: "*", effect: "ask" },
      ]);
    } finally {
      await resumed.close("shutdown");
    }
  },
);
