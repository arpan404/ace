import { expect, it } from "vitest";
import { messageId, promptBody } from "./input.ts";
it("keeps sent message IDs in native timestamp order with injected time and entropy", () => {
  expect(messageId(0, 1, "aaaaaaaaaaaaaa")).toBe("msg_000000000001aaaaaaaaaaaaaa");
  expect(messageId(1, 1, "00000000000000") > messageId(0, 2, "ffffffffffffff")).toBe(true);
  expect(messageId(1, 2, "00000000000000") > messageId(1, 1, "ffffffffffffff")).toBe(true);
});
it("resolves relative file attachments in the session workspace", () => {
  expect(
    promptBody([{ type: "file", path: "src/x.ts" }], "/project", "msg_x", "provider/model"),
  ).toMatchObject({ parts: [{ type: "file", url: "file:///project/src/x.ts" }] });
});
it("rejects an ambiguous model before any provider request is built", () => {
  expect(() =>
    promptBody([{ type: "text", text: "input" }], "/project", "msg_x", "bare-model"),
  ).toThrow("provider/model");
});
