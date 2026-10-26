import { expect, it } from "vitest";
import { InputRejected } from "@ace/engine-api";
import { setup } from "./testing/v2-session.ts";
import { array, object } from "./data.ts";

const prompts = async (h: Awaited<ReturnType<typeof setup>>) =>
  array(await h.control("/test/requests"))
    .map(object)
    .filter((r) => String(r.path).endsWith("/prompt"));

it("a prompt OpenCode turns down with a 4xx is reported as unread, so ace may send it again", async () => {
  const h = await setup();
  await h.control("/test/state", { fault: { promptRefused: true } });
  await expect(h.session.send([{ type: "text", text: "one" }], "steer")).rejects.toBeInstanceOf(
    InputRejected,
  );
  expect(await prompts(h)).toHaveLength(1);
});

it("a prompt OpenCode fails with a 5xx may have been stored, so it is reconciled, never resent", async () => {
  const h = await setup();
  await h.control("/test/state", { fault: { promptServerError: true } });
  const recovery = h.recovered();
  const sent = h.session.send([{ type: "text", text: "one" }], "steer");
  await expect(sent).rejects.toThrow("uncertain");
  await expect(sent).rejects.not.toBeInstanceOf(InputRejected);
  await recovery;
  expect(h.frames.some((frame) => frame.channel === "input.rejected")).toBe(false);
  expect(await prompts(h)).toHaveLength(1);
});
