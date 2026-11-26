import { expect, test } from "vitest";
import { array, object } from "./data.ts";
import { setup } from "./testing/v2-session.ts";

test("compaction asks OpenCode's server to compact the session's own history, and its events make one row", async () => {
  const h = await setup();
  const session = h.session;
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
    // The server's own compaction events become the one row, with its summary.
    await h.seen(
      (frame) => frame.channel === "sse" && object(frame.data).type === "session.compaction.ended",
    );
    expect(
      Object.values(h.projection.view.items).filter((item) => item.type === "compaction"),
    ).toMatchObject([
      { type: "compaction", summary: "The earlier turns, summarised by OpenCode." },
    ]);
  } finally {
    await session.close("shutdown");
  }
});
