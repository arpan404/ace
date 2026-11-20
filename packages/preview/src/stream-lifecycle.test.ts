import { expect, test } from "vitest";
import {
  lifecycleActions,
  lifecycleEvents,
  lifecycleStates,
  stateName,
  transition,
  type LifecycleEvent,
} from "./stream-lifecycle.ts";

/*
 * Every state against every event. A row reads `next action action…`, `=` meaning the state is
 * kept. The rows are checked against the module's own state and event lists, which its types are
 * derived from, so a state or event added without rows fails here.
 */
type Row = Record<LifecycleEvent, string>;
const always = { localAbort: "gone reset", peerReset: "gone drop", peerCredit: "=" } as const;
const table: Record<string, Row> = {
  "open/open/open": {
    ...always,
    localEnd: "ending/open/open sendEnd",
    endSent: "=",
    localClose: "gone reset",
    localHangup: "open/open/closed armDeadline",
    peerData: "open/writing/open queueData",
    peerEnd: "open/ended/open endSocket",
    writesDrained: "=",
    deadline: "=",
  },
  "open/writing/open": {
    ...always,
    localEnd: "ending/writing/open sendEnd",
    endSent: "=",
    localClose: "gone reset",
    localHangup: "gone reset",
    peerData: "= queueData",
    peerEnd: "open/draining/open",
    writesDrained: "open/open/open",
    deadline: "=",
  },
  "open/draining/open": {
    ...always,
    localEnd: "ending/draining/open sendEnd",
    endSent: "=",
    localClose: "gone reset",
    localHangup: "gone reset",
    peerData: "= protocolError",
    peerEnd: "= protocolError",
    writesDrained: "open/ended/open endSocket",
    deadline: "=",
  },
  "open/ended/open": {
    ...always,
    localEnd: "ending/ended/open sendEnd",
    endSent: "=",
    localClose: "gone reset",
    localHangup: "open/ended/closed armDeadline",
    peerData: "= protocolError",
    peerEnd: "= protocolError",
    writesDrained: "=",
    deadline: "=",
  },
  "ending/open/open": {
    ...always,
    localEnd: "=",
    endSent: "ended/open/open",
    localClose: "ending/open/closed armDeadline",
    localHangup: "ending/open/closed armDeadline",
    peerData: "ending/writing/open queueData",
    peerEnd: "ending/ended/open endSocket",
    writesDrained: "=",
    deadline: "=",
  },
  "ending/writing/open": {
    ...always,
    localEnd: "=",
    endSent: "ended/writing/open",
    localClose: "gone reset",
    localHangup: "gone reset",
    peerData: "= queueData",
    peerEnd: "ending/draining/open",
    writesDrained: "ending/open/open",
    deadline: "=",
  },
  "ending/draining/open": {
    ...always,
    localEnd: "=",
    endSent: "ended/draining/open",
    localClose: "gone reset",
    localHangup: "gone reset",
    peerData: "= protocolError",
    peerEnd: "= protocolError",
    writesDrained: "ending/ended/open endSocket",
    deadline: "=",
  },
  "ending/ended/open": {
    ...always,
    localEnd: "=",
    endSent: "ended/ended/open",
    localClose: "ending/ended/closed armDeadline",
    localHangup: "ending/ended/closed armDeadline",
    peerData: "= protocolError",
    peerEnd: "= protocolError",
    writesDrained: "=",
    deadline: "=",
  },
  "ended/open/open": {
    ...always,
    localEnd: "=",
    endSent: "=",
    localClose: "ended/open/closed armDeadline",
    localHangup: "ended/open/closed armDeadline",
    peerData: "ended/writing/open queueData",
    peerEnd: "ended/ended/open endSocket",
    writesDrained: "=",
    deadline: "=",
  },
  "ended/writing/open": {
    ...always,
    localEnd: "=",
    endSent: "=",
    localClose: "gone reset",
    localHangup: "gone reset",
    peerData: "= queueData",
    peerEnd: "ended/draining/open",
    writesDrained: "ended/open/open",
    deadline: "=",
  },
  "ended/draining/open": {
    ...always,
    localEnd: "=",
    endSent: "=",
    localClose: "gone reset",
    localHangup: "gone reset",
    peerData: "= protocolError",
    peerEnd: "= protocolError",
    writesDrained: "ended/ended/open endSocket",
    deadline: "=",
  },
  "ended/ended/open": {
    ...always,
    localEnd: "=",
    endSent: "=",
    localClose: "gone finish",
    localHangup: "gone finish",
    peerData: "= protocolError",
    peerEnd: "= protocolError",
    writesDrained: "=",
    deadline: "=",
  },
  "open/open/closed": {
    ...always,
    localEnd: "ending/open/closed sendEnd",
    endSent: "=",
    localClose: "=",
    localHangup: "=",
    peerData: "gone reset",
    peerEnd: "open/ended/closed",
    writesDrained: "=",
    deadline: "gone reset",
  },
  "open/ended/closed": {
    ...always,
    localEnd: "ending/ended/closed sendEnd",
    endSent: "=",
    localClose: "=",
    localHangup: "=",
    peerData: "= protocolError",
    peerEnd: "= protocolError",
    writesDrained: "=",
    deadline: "gone reset",
  },
  "ending/open/closed": {
    ...always,
    localEnd: "=",
    endSent: "ended/open/closed",
    localClose: "=",
    localHangup: "=",
    peerData: "gone reset",
    peerEnd: "ending/ended/closed",
    writesDrained: "=",
    deadline: "gone reset",
  },
  "ending/ended/closed": {
    ...always,
    localEnd: "=",
    endSent: "gone finish",
    localClose: "=",
    localHangup: "=",
    peerData: "= protocolError",
    peerEnd: "= protocolError",
    writesDrained: "=",
    deadline: "gone reset",
  },
  "ended/open/closed": {
    ...always,
    localEnd: "=",
    endSent: "=",
    localClose: "=",
    localHangup: "=",
    peerData: "gone reset",
    peerEnd: "gone finish",
    writesDrained: "=",
    deadline: "gone reset",
  },
  gone: Object.fromEntries(lifecycleEvents.map((event) => [event, "="])) as Row,
};

const cases = lifecycleStates.flatMap((state) =>
  lifecycleEvents.map((event) => ({ state, event, name: stateName(state) })),
);

test("the table has a row for every state and nothing else", () => {
  expect(Object.keys(table).toSorted()).toEqual(lifecycleStates.map(stateName).toSorted());
});

test.each(cases)("$name on $event", ({ state, event, name }) => {
  const row = table[name];
  if (!row) throw new Error(`No row for ${name}`);
  const { next, actions } = transition(state, event);
  const shown = [stateName(next) === name ? "=" : stateName(next), ...actions].join(" ");
  expect(shown).toBe(row[event]);
});

test("no event leads to a state outside the list", () => {
  const known = new Set(lifecycleStates.map(stateName));
  for (const { state, event } of cases)
    expect(known).toContain(stateName(transition(state, event).next));
});

test("every action the mux knows is one some state asks for", () => {
  const asked = new Set(cases.flatMap(({ state, event }) => transition(state, event).actions));
  expect([...asked].toSorted()).toEqual([...lifecycleActions].toSorted());
});
