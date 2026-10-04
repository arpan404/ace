import { join } from "node:path";
import { tmpdir } from "node:os";
import { sessionFixture } from "./testing/native-history.ts";
import { expect, test } from "vitest";
import { unlink, writeFile, readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { sessionHarness } from "./testing/harness.ts";
import { obj, str, list } from "./native.ts";
const text = (value: string) => [{ type: "text" as const, text: value }];
async function context(h: Awaited<ReturnType<typeof sessionHarness>>) {
  await h.session.send(text("context-proof"), "queue");
  const observed = await h.wait(
    (frame) => frame.dir === "recv" && obj(frame.data).type === "message_end",
  );
  return list(obj(obj(observed.data).message).content)
    .map((block) => str(obj(block).text))
    .join("");
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
test.each(["first-answer"])(
  "rollback to %s survives source restoration, fork resume and process reopen",
  async (target) => {
    const h = await sessionHarness();
    let reopened: Awaited<ReturnType<typeof sessionHarness>> | undefined;
    let forked: Awaited<ReturnType<typeof sessionHarness>> | undefined;
    try {
      const original = h.session.nativeSessionId;
      await h.session.rollback(target);
      const expected = "first question|first answer";
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
test("extension confirmation remains answerable while a native fork is pending", async () => {
  const h = await sessionHarness({}, false, { FAKE_PI_FORK_DIALOG: "1" });
  let reopened: Awaited<ReturnType<typeof sessionHarness>> | undefined;
  try {
    const fork = h.session.fork();
    const observed = fork.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await h.wait((frame) => frame.dir === "recv" && obj(frame.data).id === "fork-confirm");
    await h.session.resolve("fork-confirm", {
      kind: "question",
      answers: { "fork-confirm": ["yes"] },
    });
    const result = await observed;
    if (!("value" in result)) throw result.error;
    reopened = await sessionHarness({}, result.value.nativeSessionId, {}, h.home);
    expect(await context(reopened)).toBe(
      "first question|first answer|second question|abandoned answer",
    );
  } finally {
    await reopened?.dispose();
    await h.dispose();
  }
});

test.each(["root-clone", "before-first-user"])(
  "%s is refused before native replacement and keeps source context live and resumable",
  async (kind) => {
    const h = await sessionHarness();
    let reopened: Awaited<ReturnType<typeof sessionHarness>> | undefined;
    try {
      const saved = h.session.nativeSessionId;
      if (kind === "root-clone") await h.session.rollback("root-user");
      const before = await readFile(h.sourcePath, "utf8");
      await expect(h.session.fork(kind === "root-clone" ? undefined : "root-user")).rejects.toThrow(
        "assistant message",
      );
      expect(h.session.nativeSessionFile).toBe(h.sourcePath);
      expect(await readFile(h.sourcePath, "utf8")).toBe(before);
      expect(
        h.frames.filter(
          (frame) => frame.dir === "send" && ["clone", "fork"].includes(str(obj(frame.data).type)),
        ),
      ).toEqual([]);
      const expected =
        kind === "root-clone" ? "" : "first question|first answer|second question|abandoned answer";
      expect(await context(h)).toBe(expected);
      await h.session.close("idle");
      reopened = await sessionHarness({}, saved, {}, h.home);
      expect(await context(reopened)).toBe(expected);
    } finally {
      await reopened?.dispose();
      await h.dispose();
    }
  },
);
test("an unexpected unflushed fork restores the source and leaves it usable", async () => {
  const h = await sessionHarness({}, false, { FAKE_PI_DEFER_CLONE: "1" });
  try {
    await expect(h.session.fork()).rejects.toThrow("missing");
    expect(await context(h)).toBe("first question|first answer|second question|abandoned answer");
    expect(h.session.nativeSessionFile).toBe(h.sourcePath);
  } finally {
    await h.dispose();
  }
});

test.each(["cycle", "oversized"])(
  "%s fork metadata fails without replacing or closing the live source",
  async (kind) => {
    const h = await sessionHarness({}, false, { FAKE_PI_BAD_ENTRIES: kind });
    try {
      await expect(h.session.fork()).rejects.toThrow("control limit");
      expect(await context(h)).toBe("first question|first answer|second question|abandoned answer");
      expect(
        h.frames.filter(
          (frame) => frame.dir === "send" && ["clone", "fork"].includes(str(obj(frame.data).type)),
        ),
      ).toEqual([]);
    } finally {
      await h.dispose();
    }
  },
);

test("Pi identity stays short across long session paths and reopens after adapter restart", async () => {
  const { ExecutionSource } = await import("@ace/protocol");
  const root = await mkdtemp(join(tmpdir(), "ace-pi-long-path-"));
  const home = join(root, "nested-session-path-".repeat(10));
  await mkdir(home);
  await writeFile(join(home, "source.jsonl"), sessionFixture(home, "native", 3));
  const h = await sessionHarness({}, false, {}, home);
  let reopened: Awaited<ReturnType<typeof sessionHarness>> | undefined;
  try {
    const saved = h.session.nativeSessionId;
    expect(saved.length).toBeLessThanOrEqual(128);
    expect(
      ExecutionSource.parse({ nativeSessionId: saved, selection: { provider: "pi" } })
        .nativeSessionId,
    ).toBe(saved);
    await h.session.close("idle");
    reopened = await sessionHarness({}, saved, {}, h.home);
    expect(reopened.session.nativeSessionId).toBe(saved);
    expect(await context(reopened)).toBe(
      "first question|first answer|second question|abandoned answer",
    );
  } finally {
    await reopened?.dispose();
    await h.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh Pi session can acknowledge input before its first session file is flushed", async () => {
  const h = await sessionHarness({}, false, { FAKE_PI_UNSAVED: "1" });
  try {
    expect(h.session.nativeSessionId.length).toBeLessThanOrEqual(128);
    await expect(readFile(h.session.nativeSessionFile)).rejects.toMatchObject({ code: "ENOENT" });
    await h.session.send(text("context-proof"), "queue");
    await h.wait((frame) => frame.dir === "recv" && obj(frame.data).type === "message_end");
  } finally {
    await h.dispose();
  }
});
