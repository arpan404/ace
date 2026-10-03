import { expect, test } from "vitest";
import { unlink, writeFile, readFile } from "node:fs/promises";
import { sessionHarness } from "./testing/harness.ts";
import { obj, str } from "./native.ts";
const text = (value: string) => [{ type: "text" as const, text: value }];
async function context(h: Awaited<ReturnType<typeof sessionHarness>>) {
  await h.session.send(text("context-proof"), "queue");
  const observed = await h.wait(
    (frame) => frame.dir === "recv" && obj(frame.data).type === "message_end",
  );
  return str(obj(obj(observed.data).message).contextProof);
}
test.each(["missing", "empty", "replaced"])(
  "%s saved history is rejected on reopen before input delivery",
  async (kind) => {
    const h = await sessionHarness();
    const saved = h.session.nativeSessionId;
    await h.session.close("idle");
    try {
      if (kind === "missing") await unlink(h.sourcePath);
      else
        await writeFile(
          h.sourcePath,
          kind === "empty"
            ? ""
            : JSON.stringify({ type: "session", version: 3, id: "replacement", cwd: h.home }) +
                "\n",
        );
      await expect(sessionHarness({}, saved, {}, h.home)).rejects.toThrow(/saved session|identity/);
    } finally {
      await h.dispose();
    }
  },
);
test("native identity mismatches fail resume even when Pi returns the requested pathname", async () => {
  const h = await sessionHarness();
  try {
    await expect(
      sessionHarness({}, h.session.nativeSessionId, { FAKE_PI_WRONG_ID: "1" }, h.home),
    ).rejects.toThrow("identity");
  } finally {
    await h.dispose();
  }
});
test.each(["first-answer", "root-user"])(
  "rollback to %s survives source restoration, fork resume and process reopen",
  async (target) => {
    const h = await sessionHarness();
    let reopened: Awaited<ReturnType<typeof sessionHarness>> | undefined;
    let forked: Awaited<ReturnType<typeof sessionHarness>> | undefined;
    try {
      const original = h.session.nativeSessionId;
      await h.session.rollback(target);
      const expected = target === "root-user" ? "" : "first question|first answer";
      const clone = await h.session.fork();
      // Probe after fork restoration, then reopen the fork and source before any append.
      expect(await context(h)).toBe(expected);
      forked = await sessionHarness({}, clone.nativeSessionId, {}, h.home);
      expect(await context(forked)).toBe(expected);
      await h.session.close("idle");
      reopened = await sessionHarness({}, original, {}, h.home);
      expect(await context(reopened)).toBe(expected);
    } finally {
      await reopened?.dispose();
      await forked?.dispose();
      await h.dispose();
    }
  },
);
test("rollback before an earlier user drops abandoned context after reopen", async () => {
  const h = await sessionHarness();
  let reopened: Awaited<ReturnType<typeof sessionHarness>> | undefined;
  try {
    const original = h.session.nativeSessionId;
    await h.session.rollback("second-user");
    await h.session.close("idle");
    reopened = await sessionHarness({}, original, {}, h.home);
    expect(await context(reopened)).toBe("first question|first answer");
  } finally {
    await reopened?.dispose();
    await h.dispose();
  }
});
test("cancelled navigation preserves the saved native tree without a marker", async () => {
  const h = await sessionHarness({}, false, { FAKE_PI_CANCEL_ROLLBACK: "1" });
  try {
    const before = await readFile(h.sourcePath, "utf8");
    await expect(h.session.rollback("root-user")).rejects.toThrow("not acknowledged");
    expect(await readFile(h.sourcePath, "utf8")).toBe(before);
    expect(await context(h)).toBe("first question|first answer|second question|abandoned answer");
  } finally {
    await h.dispose();
  }
});
test("fork before an earlier user resumes that context while source retains its later branch", async () => {
  const h = await sessionHarness();
  let forked: Awaited<ReturnType<typeof sessionHarness>> | undefined;
  try {
    const result = await h.session.fork("second-user");
    expect(
      h.frames.filter((frame) => frame.dir === "send" && obj(frame.data).type === "prompt"),
    ).toEqual([]);
    forked = await sessionHarness({}, result.nativeSessionId, {}, h.home);
    expect(await context(forked)).toBe("first question|first answer");
    expect(await context(h)).toBe("first question|first answer|second question|abandoned answer");
  } finally {
    await forked?.dispose();
    await h.dispose();
  }
});
