import { expect, test } from "vitest";
import { machinesInSpace, shownSpace } from "./spaces.ts";

/* Which machines, and so which machines' Spade bots, a window's space shows (ADR 0206 §1.5). */

const acme = {
  id: "org_01ACME",
  name: "Acme",
  role: "member",
  plan: "pilot" as const,
  directoryManaged: false,
};
const machines = [
  { name: "This Mac", hostId: undefined },
  { name: "Studio", hostId: "STUDIO" },
  { name: "Build server", hostId: "BUILD" },
];
const names = (list: readonly { name: string }[]) => list.map((machine) => machine.name);
const hostIdOf = (machine: (typeof machines)[number]) => machine.hostId;

test("an organization's space shows only its hosts; Personal shows everything else", () => {
  const hosts = new Map([[acme.id, new Set(["BUILD"])]]);
  const inAcme = machinesInSpace(machines, hostIdOf, shownSpace(acme.id, [acme]), hosts, [acme.id]);
  expect(names(inAcme)).toEqual(["Build server"]);
  const personal = machinesInSpace(machines, hostIdOf, shownSpace("personal", [acme]), hosts, [
    acme.id,
  ]);
  expect(names(personal)).toEqual(["This Mac", "Studio"]);
});

test("until an organization's hosts are known, neither space shows a machine it can't place", () => {
  const unknown = new Map<string, ReadonlySet<string>>();
  expect(
    machinesInSpace(machines, hostIdOf, shownSpace(acme.id, [acme]), unknown, [acme.id]),
  ).toEqual([]);
  expect(
    names(machinesInSpace(machines, hostIdOf, shownSpace("personal", [acme]), unknown, [acme.id])),
  ).toEqual(["This Mac"]);
  // A chosen organization whose list hasn't answered yet shows nothing at all.
  expect(machinesInSpace(machines, hostIdOf, shownSpace(acme.id, undefined), unknown, [])).toEqual(
    [],
  );
});

test("an organization the person left shows as Personal", () => {
  expect(shownSpace(acme.id, [])?.id).toBe("personal");
});
