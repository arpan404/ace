import { describe, expect, test } from "vitest";
import { toastActivationOutcome } from "./activation.ts";

describe.runIf(process.platform === "win32")("a Windows toast activation", () => {
  test("a button, reply or click on a toast nothing answered brings ace forward", () => {
    for (const details of [
      { type: "action", arguments: "", actionIndex: 0 },
      { type: "reply", arguments: "", reply: "yes, go ahead" },
      { type: "click", arguments: "" },
    ])
      expect(toastActivationOutcome(details, false)).toBe("open");
  });

  test("one its live toast already answered does nothing more", () => {
    expect(toastActivationOutcome({ type: "action", arguments: "", actionIndex: 1 }, true)).toBe(
      "handled",
    );
  });

  test("details that are not a toast activation are never acted on", () => {
    for (const details of [
      undefined,
      "click",
      { type: "launch", arguments: "" },
      { type: "action", arguments: 7 },
      { type: "action", arguments: "", actionIndex: -1 },
      { type: "reply", arguments: "x".repeat(5000) },
    ])
      expect(toastActivationOutcome(details, false)).toBe("ignored");
  });
});
