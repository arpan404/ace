import type { AceOrgSpace } from "@ace/protocol/ace-org";
import { expect, test } from "vitest";
import { noticeSpaceLabel, shownSpace, spaceManageLine } from "./ace-spaces.ts";

/* The words a phone shows for a space (ADR 0206 §1.4): the admin's one row and notice labels. */

const org = (role: string): AceOrgSpace => ({
  id: "org_acme",
  name: "Acme Robotics",
  role,
  plan: "team",
  directoryManaged: false,
});

test("an admin or owner of the shown organization is pointed to desktop or the web to manage it", () => {
  expect(spaceManageLine(shownSpace("org_acme", [org("admin")]))).toBe(
    "Manage Acme Robotics on desktop or the web",
  );
  expect(spaceManageLine(shownSpace("org_acme", [org("owner")]))).toBe(
    "Manage Acme Robotics on desktop or the web",
  );
});

test("a member, Personal and a space still loading get no manage row", () => {
  expect(spaceManageLine(shownSpace("org_acme", [org("member")]))).toBeUndefined();
  expect(spaceManageLine(shownSpace("personal", [org("admin")]))).toBeUndefined();
  expect(spaceManageLine(shownSpace("org_acme", undefined))).toBeUndefined();
});

test("notices name their space only once the person has an organization to tell it from", () => {
  expect(noticeSpaceLabel(undefined, [])).toBeUndefined();
  expect(noticeSpaceLabel(undefined, undefined)).toBeUndefined();
  expect(noticeSpaceLabel(undefined, [org("member")])).toBe("Personal");
  expect(noticeSpaceLabel(org("member"), [org("member")])).toBe("Acme Robotics");
});
