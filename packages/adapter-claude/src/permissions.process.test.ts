import { expect, test } from "vitest";
import { harness } from "./session.test-helper.ts";
import { object } from "./native.ts";
test.each(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"] as const)(
  "Claude receives native %s unchanged",
  async (mode) => {
    const h = await harness(undefined, "root", {}, { permissionMode: mode });
    try {
      const frame = await h.wait(
        (candidate) =>
          object(candidate.data).subtype === "fake_control" &&
          object(object(candidate.data).request).subtype === "initialize",
      );
      expect(object(frame.data).settings).toMatchObject({ permissionMode: mode });
      const request = object(object(frame.data).request);
      expect(JSON.stringify(request)).not.toContain("PreToolUse");
    } finally {
      await h.session.close("shutdown");
    }
  },
);
test("Claude startup leaves the permission choice to the native harness when unset", async () => {
  const h = await harness();
  try {
    const frame = await h.wait(
      (candidate) =>
        object(candidate.data).subtype === "fake_control" &&
        object(object(candidate.data).request).subtype === "initialize",
    );
    expect(object(object(frame.data).settings).permissionMode).toBeUndefined();
  } finally {
    await h.session.close("shutdown");
  }
});
