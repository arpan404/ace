import { expect, test } from "vitest";
import { accessModeOffers } from "@ace/provider-kit/access-modes";
import {
  accessChoices,
  newThreadAccess,
  supportedAccess,
  threadAccessSummary,
} from "./permissions.ts";

const offers = (provider: "claude" | "opencode" | "cursor") => accessModeOffers({ provider });

test("the access menu shows ace's four modes, without the ones a provider can't express", () => {
  expect(accessChoices(offers("claude")).map((choice) => choice.label)).toEqual([
    "Read-only",
    "Ask",
    "Auto review",
    "Full access",
  ]);
  expect(accessChoices(offers("opencode")).map((choice) => choice.label)).toEqual([
    "Read-only",
    "Ask",
    "Full access",
  ]);
  expect(accessChoices(offers("cursor")).map((choice) => choice.label)).toEqual([
    "Auto review",
    "Full access",
  ]);
  expect(accessChoices(offers("claude")).filter((choice) => choice.attention)).toEqual([
    expect.objectContaining({ mode: "full-access" }),
  ]);
});

test("a default a provider lacks runs as its nearest stricter mode and the chip says why", () => {
  expect(supportedAccess("auto-review", offers("opencode"))).toBe("ask");
  expect(supportedAccess("ask", offers("cursor"))).toBeUndefined();
  const summary = threadAccessSummary(
    { override: null, effective: "ask", pending: false },
    offers("opencode"),
    { defaultMode: "auto-review", provider: "OpenCode" },
  );
  expect(summary).toMatchObject({
    mode: "ask",
    label: "Ask",
    inherited: true,
    stricter: "Auto review isn't available for OpenCode",
  });
});

test("a chosen mode shows as pending until the provider runs it", () => {
  const summary = threadAccessSummary(
    { override: "ask", effective: "ask", pending: false },
    offers("claude"),
    { chosen: "full-access" },
  );
  expect(summary).toMatchObject({ mode: "ask", next: "full-access", inherited: false });
});

test("an Advanced native override reads as Custom", () => {
  expect(
    threadAccessSummary(
      { override: null, effective: null, custom: "my-profile", pending: false },
      offers("claude"),
      { defaultMode: "auto-review" },
    ),
  ).toMatchObject({ label: "Custom", custom: "my-profile", mode: null, stricter: undefined });
});

test("a new thread runs at the draft's choice, else the project's default, else the daemon's", () => {
  const base = { daemonDefault: "ask", offers: offers("claude"), provider: "Claude" } as const;
  expect(newThreadAccess({ ...base, chosen: undefined, projectDefault: undefined }).admitted).toBe(
    "ask",
  );
  const project = newThreadAccess({ ...base, chosen: undefined, projectDefault: "read-only" });
  expect([project.admitted, project.permission]).toEqual(["read-only", "read-only"]);
  const chosen = newThreadAccess({ ...base, chosen: "full-access", projectDefault: "read-only" });
  expect([chosen.admitted, chosen.summary?.label]).toEqual(["full-access", "Full access"]);
});

test("a new thread never runs looser than asked: it steps down, or Send waits with the reason", () => {
  const stepped = newThreadAccess({
    chosen: "auto-review",
    projectDefault: undefined,
    daemonDefault: undefined,
    offers: offers("opencode"),
    provider: "OpenCode",
  });
  expect([stepped.admitted, stepped.problem]).toEqual(["ask", undefined]);
  const none = newThreadAccess({
    chosen: "ask",
    projectDefault: undefined,
    daemonDefault: undefined,
    offers: offers("cursor"),
    provider: "Cursor",
  });
  expect(none.permission).toBeUndefined();
  expect(none.problem).toBe(
    "Cursor has nothing as strict as Ask. Choose its access before sending.",
  );
});

test("before the provider's modes are read only a mode picked here goes with the create", () => {
  const unread = { offers: [], provider: undefined, projectDefault: "ask" } as const;
  expect(
    newThreadAccess({ ...unread, chosen: undefined, daemonDefault: "full-access" }).permission,
  ).toBeUndefined();
  expect(
    newThreadAccess({ ...unread, chosen: "read-only", daemonDefault: undefined }).permission,
  ).toBe("read-only");
});
