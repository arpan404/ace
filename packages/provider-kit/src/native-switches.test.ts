// SPDX-License-Identifier: Apache-2.0

/**
 * No test covered switch resolution before this file: each switch was read where it was used, so
 * nothing guarded the boot-time rule (ADR 0226 §6) that a phase needing another comes on with it
 * or falls back, and that a phase named explicitly never starts without its needs.
 */
import { expect, test } from "vitest";
import {
  explicitTransportPhases,
  NativeSwitchConflict,
  resolveSwitches,
  sessionSwitchRefusal,
  type CrossSwitch,
  type SwitchNeed,
} from "./native-switches.ts";

const phases = (list: readonly string[]) => new Set(list);

/** A chain listed dependents-first, so one pass in table order cannot resolve it. */
const chain: readonly SwitchNeed[] = [
  { phase: "phase.three", needs: ["phase.two"] },
  { phase: "phase.two", needs: ["phase.one"] },
];

test.each([
  {
    name: "nothing asked for keeps every phase off",
    explicit: [],
    defaultOn: [],
    needs: chain,
    on: [],
    fellBack: [],
  },
  {
    name: "a default-on phase whose need is on stays",
    explicit: [],
    defaultOn: ["phase.one", "phase.two", "phase.three"],
    needs: chain,
    on: ["phase.one", "phase.two", "phase.three"],
    fellBack: [],
  },
  {
    name: "a default phase whose need is off falls back and takes everything that needs it",
    explicit: [],
    defaultOn: ["phase.two", "phase.three"],
    needs: chain,
    on: [],
    fellBack: [
      { phase: "phase.two", because: "phase.one" },
      { phase: "phase.three", because: "phase.two" },
    ],
  },
  {
    name: "an explicitly set need keeps the phases that default on above it",
    explicit: ["phase.one"],
    defaultOn: ["phase.two", "phase.three"],
    needs: chain,
    on: ["phase.one", "phase.two", "phase.three"],
    fellBack: [],
  },
  {
    name: "an explicit phase whose needs are explicit stays",
    explicit: ["phase.one", "phase.three"],
    defaultOn: [],
    needs: [{ phase: "phase.three", needs: ["phase.one"] }],
    on: ["phase.one", "phase.three"],
    fellBack: [],
  },
])("$name", ({ explicit, defaultOn, needs, on, fellBack }) => {
  const resolved = resolveSwitches(phases(explicit), phases(defaultOn), needs);
  expect([...resolved.on].toSorted()).toEqual([...on].toSorted());
  expect(resolved.fellBack).toEqual(fellBack);
});

test.each([
  {
    name: "an explicit phase whose need fell back as a default is refused, not started",
    explicit: ["phase.three"],
    defaultOn: ["phase.two"],
    needs: chain,
    conflict: ["phase.three", "phase.two"],
  },
  {
    name: "a phase in both sets is refused when its need is missing, never silently falling back",
    explicit: ["phase.two"],
    defaultOn: ["phase.two"],
    needs: chain,
    conflict: ["phase.two", "phase.one"],
  },
  {
    name: "an explicit phase whose need is not on at all is refused, naming both",
    explicit: ["phase.three"],
    defaultOn: [],
    needs: [{ phase: "phase.three", needs: ["phase.one"] }],
    conflict: ["phase.three", "phase.one"],
  },
])("$name", ({ explicit, defaultOn, needs, conflict: [phase, need] }) => {
  let thrown: unknown;
  try {
    resolveSwitches(phases(explicit), phases(defaultOn), needs);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(NativeSwitchConflict);
  const message = (thrown as Error).message;
  expect(message).toContain(phase);
  expect(message).toContain(need);
});

test.each([
  { name: "unset asks for nothing", value: undefined, asked: [] },
  {
    name: "native asks for the loopback listener",
    value: "native",
    asked: ["transport.loopback"],
  },
  {
    name: "native,remote asks for both listeners",
    value: "native,remote",
    asked: ["transport.loopback", "transport.remote"],
  },
])("ACE_TRANSPORT %s", ({ value, asked }) => {
  expect([...explicitTransportPhases(value)].toSorted()).toEqual(asked);
});

test.each(["", "bogus", "remote", "native, remote"])(
  "ACE_TRANSPORT=%s is refused, quoting the value it read",
  (value) => {
    expect(() => explicitTransportPhases(value)).toThrow(`ACE_TRANSPORT=${JSON.stringify(value)}`);
  },
);

interface SessionRefusalCase {
  name: string;
  sessions: readonly string[];
  store: boolean;
  supervisor: boolean;
  cross: CrossSwitch | undefined;
  refusal: string | undefined;
}

/** A native session needs the native store and supervisor, and never the supervisor's cross. */
test.each<SessionRefusalCase>([
  {
    name: "a named session without the native store",
    sessions: ["pi"],
    store: false,
    supervisor: true,
    cross: undefined,
    refusal: "ACE_SESSIONS needs ACE_STORE=native",
  },
  {
    name: "a named session without the native supervisor",
    sessions: ["pi"],
    store: true,
    supervisor: false,
    cross: undefined,
    refusal: "ACE_SESSIONS needs ACE_SUPERVISOR=native",
  },
  {
    name: "a named session under the supervisor's cross switch",
    sessions: ["pi"],
    store: true,
    supervisor: true,
    cross: "ACE_SUPERVISOR",
    refusal: "ACE_NATIVE_CROSS=ACE_SUPERVISOR cannot run with ACE_SESSIONS",
  },
  {
    name: "both needs off, which names the store first",
    sessions: ["pi"],
    store: false,
    supervisor: false,
    cross: undefined,
    refusal: "ACE_SESSIONS needs ACE_STORE=native",
  },
  {
    name: "the cross gate naming the sessions switch without a native supervisor",
    sessions: [],
    store: true,
    supervisor: false,
    cross: "ACE_SESSIONS",
    refusal: "ACE_SESSIONS needs ACE_SUPERVISOR=native",
  },
  {
    name: "nothing naming the sessions switch",
    sessions: [],
    store: true,
    supervisor: true,
    cross: undefined,
    refusal: undefined,
  },
])("$name", ({ sessions, store, supervisor, cross, refusal }) => {
  expect(sessionSwitchRefusal({ sessions, store, supervisor, cross })).toBe(refusal);
});
