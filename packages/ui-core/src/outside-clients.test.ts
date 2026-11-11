import { WorkspaceId, type OutsideGrantEntry } from "@ace/protocol";
import { describe, expect, test } from "vitest";
import {
  accessRequestSentence,
  approvalDecision,
  arrangeGrants,
  expiryWords,
  grantState,
  initialChoice,
  lifetimeEnd,
  projectsWords,
  redirectWords,
  scopeChoices,
  scopeWords,
  screenUseSentence,
  startedByWords,
} from "./outside-clients.ts";

const now = 1_800_000_000_000;
const hour = 3_600_000;
const day = 24 * hour;

function grant(id: string, facts: Partial<OutsideGrantEntry> = {}): OutsideGrantEntry {
  return {
    id,
    clientKind: "cimd",
    clientId: `https://${id}.example/client.json`,
    name: id,
    domain: `${id}.example`,
    scopes: ["threads:read"],
    projects: "all",
    createdAt: now - 10 * day,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    approvedBy: "device-1",
    started: [],
    messaged: [],
    ...facts,
  };
}

describe("what a grant may do, in words", () => {
  test.each([
    [["threads:read"], "Read threads"],
    [["threads:read", "threads:start"], "Read and start threads"],
    [["threads:read", "threads:start", "threads:message"], "Read, start and message threads"],
    [["threads:read", "threads:stop"], "Read and stop threads"],
    [["threads:read", "browser"], "Read threads and use the browser"],
    [
      ["threads:read", "threads:start", "browser", "computer"],
      "Read and start threads, use the browser and use the screen",
    ],
  ] as const)("%j reads %s", (scopes, words) => {
    expect(scopeWords(scopes)).toBe(words);
  });

  test("read is said even when a grant's list leaves it out", () => {
    expect(scopeWords(["threads:message"])).toBe("Read and message threads");
  });

  test("projects read as all, one or two by name, or a count", () => {
    const names: Record<string, string> = { a: "ace", b: "web" };
    const known = (id: string) => names[id];
    expect(projectsWords("all", known)).toBe("All projects");
    expect(projectsWords([WorkspaceId.parse("a")], known)).toBe("ace");
    expect(projectsWords(["a", "b"], known)).toBe("ace and web");
    expect(projectsWords(["a", "b", "c"], known)).toBe("3 projects");
  });

  test("a project the client doesn't know by name shows its id", () => {
    expect(projectsWords(["a", "unknown"], (id) => (id === "a" ? "ace" : undefined))).toBe(
      "ace and unknown",
    );
  });
});

describe("when a grant ends, in words", () => {
  test.each([
    [null, "Until revoked"],
    [now - 1, "Expired"],
    [now + 30_000, "Expires in 1 minute"],
    [now + 20 * 60_000, "Expires in 20 minutes"],
    [now + hour, "Expires in 1 hour"],
    [now + 5 * hour, "Expires in 5 hours"],
    [now + day, "Expires in 1 day"],
    [now + 30 * day - 1000, "Expires in 30 days"],
  ] as const)("ending at %s reads %s", (expiresAt, words) => {
    expect(expiryWords(expiresAt, now)).toBe(words);
  });
});

describe("how long a grant lasts", () => {
  test("a day or 30 days from now, or until revoked", () => {
    expect(lifetimeEnd("day", 1_000)).toBe(1_000 + day);
    expect(lifetimeEnd("month", 1_000)).toBe(1_000 + 30 * day);
    expect(lifetimeEnd("forever", 1_000)).toBeNull();
  });

  test("a phone's fractional clock still gives whole milliseconds", () => {
    expect(lifetimeEnd("day", 1_000.75)).toBe(1_000 + day);
  });

  test("a grant is revoked, expired or active", () => {
    expect(grantState({ expiresAt: null, revokedAt: null }, 5)).toBe("active");
    expect(grantState({ expiresAt: 10, revokedAt: null }, 5)).toBe("active");
    expect(grantState({ expiresAt: 5, revokedAt: null }, 5)).toBe("expired");
    expect(grantState({ expiresAt: 10, revokedAt: 2 }, 5)).toBe("revoked");
  });
});

describe("the grants list", () => {
  test("live grants come first by last use; revoked and expired ones are ended", () => {
    const { live, ended } = arrangeGrants(
      [
        grant("old", { lastUsedAt: now - day }),
        grant("revoked", { revokedAt: now - hour }),
        grant("fresh", { lastUsedAt: now - 60_000 }),
        grant("expired", { expiresAt: now - 2 * hour }),
        grant("unused"),
      ],
      now,
    );
    expect(live.map((entry) => entry.id)).toEqual(["fresh", "old", "unused"]);
    expect(ended.map((entry) => entry.id)).toEqual(["revoked", "expired"]);
  });
});

describe("access requests", () => {
  const request = {
    requestId: "r1",
    clientName: "Claude",
    domain: "claude.ai",
    scopes: ["threads:read", "threads:start"] as ["threads:read", "threads:start"],
    matchCode: "4F7K",
    expiresAt: now + 600_000,
  };

  test("the notice names the client, its domain, the machine and the code", () => {
    expect(accessRequestSentence(request, "Studio")).toBe(
      "Claude (claude.ai) wants to use Studio. Code 4F7K.",
    );
  });

  test("an unverified client is named without a domain", () => {
    expect(accessRequestSentence({ ...request, domain: null }, "Studio")).toBe(
      "Claude wants to use Studio. Code 4F7K.",
    );
  });

  test("a website redirect names the host the code goes to", () => {
    expect(redirectWords({ redirectHost: "claude.ai", redirectKind: "web" })).toBe(
      "Signs in to claude.ai",
    );
  });

  test("a loopback or app-scheme redirect warns instead of naming a host", () => {
    for (const redirectHost of ["127.0.0.1", "cursor:"])
      expect(redirectWords({ redirectHost, redirectKind: "this-device" })).toBe(
        "The code goes to an app on the device where the sign-in started. Approve only if you started it.",
      );
  });

  test("an older daemon that doesn't say where the code goes shows no line", () => {
    expect(redirectWords({})).toBeUndefined();
  });

  test("sign-in ticks start with read on and fixed, the rest off, asked ones marked", () => {
    const choices = scopeChoices(["threads:read", "threads:start", "computer"]);
    const where = (key: "on" | "fixed" | "asked") =>
      choices.filter((choice) => choice[key]).map((choice) => choice.scope);
    expect(where("on")).toEqual(["threads:read"]);
    expect(where("fixed")).toEqual(["threads:read"]);
    expect(where("asked")).toEqual(["threads:read", "threads:start", "computer"]);
  });

  test("editing a grant's ticks starts from what it holds", () => {
    const choices = scopeChoices([], ["threads:read", "threads:stop"]);
    expect(choices.filter((choice) => choice.on).map((choice) => choice.scope)).toEqual([
      "threads:read",
      "threads:stop",
    ]);
  });

  test("approving untouched gives read only, every project, for 30 days", () => {
    expect(approvalDecision(initialChoice(), now)).toEqual({
      decision: "approve",
      scopes: ["threads:read"],
      projects: "all",
      expiresAt: now + 30 * day,
    });
  });

  test("approving keeps read and sends ticks in a stable order", () => {
    const decision = approvalDecision(
      {
        scopes: new Set(["computer", "threads:start"]),
        projects: [WorkspaceId.parse("w1")],
        lifetime: "forever",
      },
      now,
    );
    expect(decision).toEqual({
      decision: "approve",
      scopes: ["threads:read", "threads:start", "computer"],
      projects: ["w1"],
      expiresAt: null,
    });
  });
});

test("the screen line names who is using the machine", () => {
  expect(screenUseSentence(["Claude"], "this Mac")).toBe("Claude is using this Mac");
  expect(screenUseSentence(["Claude", "ChatGPT", "Claude"], "Studio")).toBe(
    "Claude and ChatGPT are using Studio",
  );
  expect(screenUseSentence([" "], "this computer")).toBe("An outside app is using this computer");
});

test("a thread an outside client started says who", () => {
  expect(startedByWords("Claude")).toBe("Started by Claude");
  expect(startedByWords("  ")).toBe("Started by an outside app");
});
