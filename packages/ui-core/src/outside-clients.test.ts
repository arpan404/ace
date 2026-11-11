import { WorkspaceId, type OutsideGrantEntry } from "@ace/protocol";
import { describe, expect, test } from "vitest";
import {
  accessRequestSentence,
  approvalDecision,
  arrangeGrants,
  expiryWords,
  initialChoice,
  projectsWords,
  scopeWords,
  screenUseSentence,
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

const name = (id: string) => (id === "w1" ? "ace" : id);

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

  test("projects read as all, one by name, or a count", () => {
    expect(projectsWords("all", name)).toBe("All projects");
    const w1 = WorkspaceId.parse("w1");
    expect(projectsWords([w1], name)).toBe("ace");
    expect(projectsWords([w1, WorkspaceId.parse("w2"), WorkspaceId.parse("w3")], name)).toBe(
      "3 projects",
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

  test("a grant asking for more says so", () => {
    expect(accessRequestSentence({ ...request, grantId: "g1" }, "Studio")).toBe(
      "Claude (claude.ai) wants more access to Studio. Code 4F7K.",
    );
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
});
