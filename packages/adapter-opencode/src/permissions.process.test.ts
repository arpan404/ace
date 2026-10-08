import { expect, test } from "vitest";
import { setup } from "./testing/v2-session.ts";
import { array, object } from "./data.ts";
test.each(["allow", "ask", "deny"] as const)(
  "OpenCode receives native %s rule on launch and resume",
  async (mode) => {
    const h = await setup();
    const source = await h.open("/two", undefined, mode);
    const native = source.nativeSessionId;
    await source.close("idle");
    const resumed = await h.open("/two", native, mode);
    try {
      const requests = array(await h.control("/test/requests")).map(object);
      const create = requests.find(
        (request) =>
          request.path === "/api/session" &&
          object(object(request.body).location).directory === "/two",
      );
      expect(object(create?.body).permissions).toEqual([
        { action: "*", resource: "*", effect: mode },
      ]);
      const update = requests.find(
        (request) =>
          request.path === `/api/session/${native}` &&
          object(request.body).permissions !== undefined,
      );
      expect(object(update?.body).permissions).toEqual([
        { action: "*", resource: "*", effect: mode },
      ]);
    } finally {
      await resumed.close("shutdown");
    }
  },
);
