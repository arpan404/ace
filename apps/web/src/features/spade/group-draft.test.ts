import { parseSpadeAvatar } from "@ace/ui-core/spade-chat";
import { expect, test } from "vitest";
import {
  draftBody,
  draftLead,
  draftProblem,
  draftStart,
  type MemberChoice,
} from "./group-draft.ts";

const choice = (host: string, agent: string, main = false): MemberChoice => ({
  key: `${host}/${agent}`,
  agent,
  host,
  name: agent,
  avatar: parseSpadeAvatar(undefined, agent),
  machineName: host,
  main,
  away: false,
});
const spadeHere = choice("mac", "main", true);
const research = choice("mac", "research");
const writer = choice("studio", "writer");
const studioSpade = choice("studio", "spade-studio", true);

test("a draft starts with Spade of this machine picked, and nothing when Spade doesn't run here", () => {
  expect(draftStart([research, studioSpade, spadeHere], "mac")).toEqual(["mac/main"]);
  expect(draftStart([research, studioSpade], "mac")).toEqual([]);
});

test("the lead is the one asked for while picked, else Spade while picked, else the first picked", () => {
  expect(draftLead([research, spadeHere, writer], "studio/writer")).toBe(writer);
  expect(draftLead([research, spadeHere], "studio/writer")).toBe(spadeHere);
  expect(draftLead([writer, research], undefined)).toBe(writer);
  expect(draftLead([], undefined)).toBeUndefined();
});

test("a draft led from another machine names this machine's members against the lead's", () => {
  expect(draftBody(" Trips ", [research, writer], writer)).toEqual({
    name: "Trips",
    members: [{ agent: "research", machine: "mac" }, { agent: "writer" }],
    lead: "writer",
  });
});

test("a draft needs a name and two to eight members", () => {
  expect(draftProblem(" ", [spadeHere, research])).toBe("Name the club.");
  expect(draftProblem("Trips", [spadeHere])).toBe("Pick at least one more bot.");
  const nine = Array.from({ length: 9 }, (_, index) => choice("mac", `bot${index}`));
  expect(draftProblem("Trips", nine)).toBe("A club holds up to 8 bots.");
  expect(draftProblem("Trips", [spadeHere, research])).toBeUndefined();
});
