import type { AceOrgSpace } from "@ace/protocol/ace-org";
import { expect, test } from "vitest";
import spaceCases from "./ace-spaces-cases.json" with { type: "json" };
import {
  machinesInSpace,
  noticeSpaceLabel,
  orgOfHost,
  shownSpace,
  spaceManageLine,
  spaceStartBlock,
} from "./ace-spaces.ts";

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

/* `spaceCases` is the table the iPhone's Swift copy of these rules is tested against too. */
interface SpaceCase {
  case: string;
  chosen: string;
  spaces: AceOrgSpace[] | null;
  hostsOf: Record<string, string[]>;
  orgs: string[] | null;
  machines: (string | null)[];
  noticeHost: string | null;
  expect: {
    shown: string | null;
    inSpace: number[];
    startBlock: string | null;
    /** The same sentence as the iPhone words it: a phone has no windows. */
    phoneStartBlock: string | null;
    manage: string | null;
    noticeLabel: string | null;
  };
}
const table = spaceCases as SpaceCase[];

test.each(table.map((entry) => [entry.case, entry] as const))("%s", (_name, entry) => {
  const spaces = entry.spaces ?? undefined;
  const hostsOf = new Map(Object.entries(entry.hostsOf).map(([org, ids]) => [org, new Set(ids)]));
  const shown = shownSpace(entry.chosen, spaces);
  const indices = entry.machines.map((_machine, index) => index);
  const inSpace = machinesInSpace(
    indices,
    (index) => entry.machines[index] ?? undefined,
    shown,
    hostsOf,
    entry.orgs ?? undefined,
  );
  const fromOrg = orgOfHost(entry.noticeHost ?? undefined, spaces ?? [], hostsOf);
  expect({
    shown: shown?.id ?? null,
    inSpace,
    startBlock: spaceStartBlock(shown, hostsOf, inSpace.length) ?? null,
    phoneStartBlock: spaceStartBlock(shown, hostsOf, inSpace.length, "phone") ?? null,
    manage: spaceManageLine(shown) ?? null,
    noticeLabel: noticeSpaceLabel(fromOrg, spaces) ?? null,
  }).toEqual(entry.expect);
});
