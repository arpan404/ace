import { deriveThreadStatus } from "@ace/core";
import { readFile, rm } from "node:fs/promises";
import { expect, test } from "vitest";
import { PermissionMode } from "@ace/protocol";
import { sessionHarness } from "./testing/harness.ts";

test("Pi Ask holds a shell edit until its approval card receives a human decision", async () => {
  const h = await sessionHarness({}, false, {}, undefined, "ask");
  try {
    await h.session.send([{ type: "text", text: "gated-shell" }], "queue");
    const approval = Object.values(h.h.state.interactions).find(
      (entry) => entry.state === "pending" && entry.request.kind === "approval",
    );
    expect(approval?.request).toMatchObject({
      kind: "approval",
      target: { tool: "bash", command: expect.stringContaining("approved.txt") },
    });
    if (!approval) throw new Error("Missing shell approval");
    expect(deriveThreadStatus(h.h.state).state).toBe("needs_you");
    expect(await readFile(`${h.home}/approved.txt`, "utf8").catch(() => "missing")).toBe("missing");
    await h.session.resolve("tool-approval-1", { kind: "approval", optionId: "allow" });
    await h.wait(
      (frame) =>
        frame.dir === "recv" && JSON.stringify(frame.data).includes("gated write completed"),
    );
    expect(await readFile(`${h.home}/approved.txt`, "utf8")).toBe("approved");
  } finally {
    await h.dispose();
  }
});

test.each(
  ["auto-review", "ask", "read-only", "full-access"].flatMap((mode) =>
    [false, true].map((resume) => ({ mode, resume })),
  ),
)(
  "Pi $mode (resume=$resume) launches with the selected native tools and never falls back to full access",
  async ({ mode, resume }) => {
    const expected = mode === "read-only" ? "write unavailable" : "write available";
    const h = await sessionHarness({}, resume, {}, undefined, PermissionMode.parse(mode));
    try {
      await h.session.send([{ type: "text", text: "write-proof" }], "queue");
      await h.wait((f) => f.dir === "recv" && JSON.stringify(f.data).includes(expected));
      expect(
        Object.values(h.h.state.items).some((item) => JSON.stringify(item).includes(expected)),
      ).toBe(true);
      await h.session.send([{ type: "text", text: "tools-proof" }], "queue");
      const proof = JSON.stringify({
        tools:
          mode === "full-access"
            ? "all"
            : mode === "read-only"
              ? ["read", "grep", "find", "ls"]
              : ["read", "write", "edit", "bash", "grep", "find", "ls"],
        ambientExtensions: mode === "full-access",
      });
      const observed = await h.wait(
        (f) =>
          f.dir === "recv" && JSON.stringify(f.data).includes(JSON.stringify(proof).slice(1, -1)),
      );
      expect(JSON.stringify(observed.data)).toContain(JSON.stringify(proof).slice(1, -1));
    } finally {
      await h.dispose();
    }
  },
);

test.each(
  (["ask", "auto-review"] as const).flatMap((mode) =>
    [false, true].map((resume) => ({ mode, resume })),
  ),
)(
  "Pi $mode gates writes before execution and accepts only a one-shot approval, resume=$resume",
  async ({ mode, resume }) => {
    const h = await sessionHarness({}, resume, {}, undefined, mode);
    try {
      await h.session.send([{ type: "text", text: "gated-write" }], "queue");
      const approval = Object.values(h.h.state.interactions).find(
        (interaction) => interaction.request.kind === "approval",
      );
      expect(approval?.request).toMatchObject({
        kind: "approval",
        target: { tool: "write", access: "write", paths: [`${h.home}/approved.txt`] },
      });
      if (!approval) throw new Error("Missing approval");
      expect(deriveThreadStatus(h.h.state).state).toBe("needs_you");
      expect(await readFile(`${h.home}/approved.txt`, "utf8").catch(() => "missing")).toBe(
        "missing",
      );
      await expect(
        h.session.resolve("tool-approval-1", { kind: "approval", optionId: "allow_always" }),
      ).rejects.toThrow();
      await h.session.resolve("tool-approval-1", { kind: "approval", optionId: "allow" });
      await h.wait(
        (f) => f.dir === "recv" && JSON.stringify(f.data).includes("gated write completed"),
      );
      expect(await readFile(`${h.home}/approved.txt`, "utf8")).toBe("approved");
      await expect(
        h.session.resolve("tool-approval-1", { kind: "approval", optionId: "allow" }),
      ).rejects.toThrow("no longer pending");
      await rm(`${h.home}/approved.txt`);
      await h.session.send([{ type: "text", text: "gated-write" }], "queue");
      await h.wait(
        (f) => f.dir === "recv" && JSON.stringify(f.data).includes('"id":"tool-approval-2"'),
      );
      expect(deriveThreadStatus(h.h.state).state).toBe("needs_you");
      expect(await readFile(`${h.home}/approved.txt`, "utf8").catch(() => "missing")).toBe(
        "missing",
      );
      await h.session.resolve("tool-approval-2", { kind: "approval", optionId: "deny" });
      await h.wait(
        (f) => f.dir === "recv" && JSON.stringify(f.data).includes("gated write denied"),
      );
      expect(await readFile(`${h.home}/approved.txt`, "utf8").catch(() => "missing")).toBe(
        "missing",
      );
    } finally {
      await h.dispose();
    }
  },
);

test("Pi denial completes a blocked tool without creating a file", async () => {
  const h = await sessionHarness({}, false, {}, undefined, "auto-review");
  try {
    await h.session.send([{ type: "text", text: "gated-write" }], "queue");
    await h.session.resolve("tool-approval-1", { kind: "approval", optionId: "deny" });
    await h.wait((f) => f.dir === "recv" && JSON.stringify(f.data).includes("gated write denied"));
    expect(await readFile(`${h.home}/approved.txt`, "utf8").catch(() => "missing")).toBe("missing");
  } finally {
    await h.dispose();
  }
});

test("concurrent Pi approval resolutions admit exactly one decision and a retry cannot change it", async () => {
  const h = await sessionHarness({}, false, {}, undefined, "ask");
  try {
    await h.session.send([{ type: "text", text: "gated-write" }], "queue");
    const responses = await Promise.allSettled([
      h.session.resolve("tool-approval-1", { kind: "approval", optionId: "deny" }),
      h.session.resolve("tool-approval-1", { kind: "approval", optionId: "allow" }),
    ]);
    expect(responses.map((response) => response.status)).toEqual(["fulfilled", "rejected"]);
    await h.wait((f) => f.dir === "recv" && JSON.stringify(f.data).includes("gated write denied"));
    expect(await readFile(`${h.home}/approved.txt`, "utf8").catch(() => "missing")).toBe("missing");
    await expect(
      h.session.resolve("tool-approval-1", { kind: "approval", optionId: "allow" }),
    ).rejects.toThrow("no longer pending");
  } finally {
    await h.dispose();
  }
});

test.each(["FAKE_PI_NO_UI", "FAKE_PI_MALFORMED_TOOL", "FAKE_PI_APPROVAL_FAILURE"])(
  "Pi blocks writes when %s prevents a trustworthy approval",
  async (trigger) => {
    const h = await sessionHarness({}, false, { [trigger]: "1" }, undefined, "auto-review");
    try {
      await h.session.send([{ type: "text", text: "gated-write" }], "queue");
      await h.wait(
        (f) => f.dir === "recv" && JSON.stringify(f.data).includes("gated write denied"),
      );
      expect(await readFile(`${h.home}/approved.txt`, "utf8").catch(() => "missing")).toBe(
        "missing",
      );
      expect(
        Object.values(h.h.state.interactions).filter(
          (interaction) => interaction.state === "pending",
        ),
      ).toEqual([]);
    } finally {
      await h.dispose();
    }
  },
);
