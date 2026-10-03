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
