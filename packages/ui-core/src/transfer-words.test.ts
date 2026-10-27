import { HostId, WorkspaceId, type Transfer } from "@ace/protocol";
import { expect, test } from "vitest";
import { doneWords } from "./transfer-words.ts";

type Result = NonNullable<Transfer["result"]>;

const opened = (result: Partial<Result>) =>
  doneWords({
    kind: "project",
    target: { hostId: HostId.parse("studio"), name: "Studio" },
    result: { workspaceId: WorkspaceId.parse("w"), path: "/p", ...result },
  });

test("a project sent again says how many of its files the copy there kept", () => {
  expect(opened({ keptFiles: 3 })).toBe("Opened on Studio · kept its own copy of 3 files");
  expect(opened({ keptFiles: 1, ignoredSkipped: 2 })).toBe(
    "Opened on Studio · kept its own copy of 1 file · kept its own copy of 2 ignored files",
  );
});

test("work that landed beside a busy checkout names the branch it is on", () => {
  expect(opened({ branch: "fix-login-from-mac", branchOnly: true })).toBe(
    "Opened on Studio on fix-login-from-mac",
  );
  expect(opened({ branch: "fix-login" })).toBe("Opened on Studio");
});
