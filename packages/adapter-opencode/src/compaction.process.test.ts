import { expect, test } from "vitest";
import { array, object } from "./data.ts";
import { setup } from "./testing/v2-session.ts";

test("compaction asks OpenCode's server to compact the session's own history", async () => {
  const h = await setup();
  const session = await h.open("/two");
  try {
    await session.compact?.();
    const requests = array(await h.control("/test/requests")).map(object);
    expect(
      requests.some(
        (request) =>
          request.method === "POST" &&
          String(request.path).endsWith(`/api/session/${session.nativeSessionId}/compact`),
      ),
    ).toBe(true);
  } finally {
    await session.close("shutdown");
  }
});
