import { expect, test } from "vitest";
import {
  outsideAccessSentence,
  outsideExpiresAt,
  outsideGrantState,
  outsideProjectsLine,
  outsideScopeChoices,
  outsideScreenLine,
  startedByClientLine,
} from "./outside-clients.ts";

const day = 24 * 60 * 60_000;

test("a grant's access reads as one sentence, read always first", () => {
  expect(outsideAccessSentence(["threads:read"])).toBe("Can read threads");
  expect(outsideAccessSentence(["threads:stop", "threads:read", "threads:start"])).toBe(
    "Can read, start and stop threads",
  );
  expect(outsideAccessSentence(["threads:read", "threads:message", "browser"])).toBe(
    "Can read and message threads, and use the browser",
  );
  expect(outsideAccessSentence(["threads:read", "computer", "browser"])).toBe(
    "Can read threads, and use the browser and the screen",
  );
});

test("projects read as all, by name, or as a count", () => {
  const names: Record<string, string> = { a: "ace", b: "web" };
  const name = (id: string) => names[id];
  expect(outsideProjectsLine("all", name)).toBe("All projects");
  expect(outsideProjectsLine(["a"], name)).toBe("ace");
  expect(outsideProjectsLine(["a", "b"], name)).toBe("ace and web");
  expect(outsideProjectsLine(["a", "unknown"], name)).toBe("ace and unknown");
  expect(outsideProjectsLine(["a", "b", "c"], name)).toBe("3 projects");
});

test("the sign-in ticks start with read on and fixed, the rest off, asked ones marked", () => {
  const choices = outsideScopeChoices({ scopes: ["threads:read", "threads:start", "computer"] });
  expect(choices.filter((choice) => choice.on).map((choice) => choice.scope)).toEqual([
    "threads:read",
  ]);
  expect(choices.filter((choice) => choice.fixed).map((choice) => choice.scope)).toEqual([
    "threads:read",
  ]);
  expect(choices.filter((choice) => choice.asked).map((choice) => choice.scope)).toEqual([
    "threads:read",
    "threads:start",
    "computer",
  ]);
});

test("a step-up starts from what the grant already holds", () => {
  const choices = outsideScopeChoices({ scopes: ["browser"] }, ["threads:read", "threads:stop"]);
  expect(choices.filter((choice) => choice.on).map((choice) => choice.scope)).toEqual([
    "threads:read",
    "threads:stop",
  ]);
  expect(choices.find((choice) => choice.scope === "browser")).toMatchObject({
    on: false,
    asked: true,
  });
});

test("expiry choices end a day or 30 days from now, or never", () => {
  expect(outsideExpiresAt("day", 1_000)).toBe(1_000 + day);
  expect(outsideExpiresAt("month", 1_000)).toBe(1_000 + 30 * day);
  expect(outsideExpiresAt("never", 1_000)).toBeNull();
  // A phone's clock reads fractions of a millisecond; the protocol takes whole ones.
  expect(outsideExpiresAt("day", 1_000.75)).toBe(1_000 + day);
});

test("a grant is revoked, expired or active", () => {
  expect(outsideGrantState({ expiresAt: null, revokedAt: null }, 5)).toBe("active");
  expect(outsideGrantState({ expiresAt: 10, revokedAt: null }, 5)).toBe("active");
  expect(outsideGrantState({ expiresAt: 5, revokedAt: null }, 5)).toBe("expired");
  expect(outsideGrantState({ expiresAt: 10, revokedAt: 2 }, 5)).toBe("revoked");
});

test("lines that name a client", () => {
  expect(startedByClientLine({ name: "Claude" })).toBe("Started by Claude");
  expect(startedByClientLine({ name: "  " })).toBe("Started by an outside app");
  expect(outsideScreenLine(["Claude"], true)).toBe("Claude is using this Mac");
  expect(outsideScreenLine(["Claude", "ChatGPT", "Claude"], false)).toBe(
    "Claude and ChatGPT are using this computer",
  );
  expect(outsideScreenLine([], true)).toBeUndefined();
});
