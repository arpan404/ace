import { expect, test } from "vitest";
import { sessionHarness } from "./testing/harness.ts";
test("Pi uses its native tool and extension defaults without an ace approval gate", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send([{ type: "text", text: "tools-proof" }], "queue");
    const proof = JSON.stringify(JSON.stringify({ tools: "all", ambientExtensions: true })).slice(
      1,
      -1,
    );
    const observed = await h.wait(
      (frame) => frame.dir === "recv" && JSON.stringify(frame.data).includes(proof),
    );
    expect(JSON.stringify(observed.data)).toContain(proof);
    await h.session.send([{ type: "text", text: "gated-write" }], "queue");
    await h.wait(
      (frame) =>
        frame.dir === "recv" && JSON.stringify(frame.data).includes("gated write completed"),
    );
    expect(
      Object.values(h.h.state.interactions).filter(
        (interaction) => interaction.request.kind === "approval",
      ),
    ).toEqual([]);
  } finally {
    await h.dispose();
  }
});
