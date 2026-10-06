import { expect, test } from "vitest";
import { setup } from "./testing/v2-session.ts";
import { object, array } from "./data.ts";

test("OpenCode publishes native command metadata without sending a model prompt", async () => {
  const h = await setup();
  const session = await h.open("/two");
  try {
    const frame = h.frames.find(
      (f) =>
        f.channel === "commands.runtime" &&
        array(object(f.data).availableCommands).some((c) => object(c).name === "native-explain"),
    );
    expect(array(object(frame?.data).availableCommands).map((c) => object(c).name)).toEqual([
      "native-explain",
    ]);
    const requests = array(await h.control("/test/requests")).map(object);
    expect(requests.some((r) => String(r.path).endsWith("/prompt"))).toBe(false);
  } finally {
    await session.close("shutdown");
  }
});

test("an unavailable native command API leaves a usable OpenCode session with an empty native list", async () => {
  const h = await setup({ discovery: { env: { ACE_TEST_COMMANDS_UNAVAILABLE: "1" } } });
  const session = await h.open("/two");
  try {
    const frames = h.frames.filter((f) => f.channel === "commands.runtime");
    expect(frames.map((f) => object(f.data).availableCommands)).toEqual([[], []]);
    await session.send([{ type: "text", text: "hello" }], "queue");
    const requests = array(await h.control("/test/requests")).map(object);
    expect(
      requests.some((r) => String(r.path).endsWith("/prompt") && object(r.body).text === "hello"),
    ).toBe(true);
  } finally {
    await session.close("shutdown");
  }
});
