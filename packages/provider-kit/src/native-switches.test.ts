// SPDX-License-Identifier: Apache-2.0

/**
 * No test covered switch resolution before this file: each switch was read where it was used, so
 * nothing guarded the boot-time rule (ADR 0226 §6) that a phase needing another comes on with it
 * or falls back, and that a phase named explicitly never starts without its needs.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  canonicalWriterParts,
  devicePlatformSwitchRefusal,
  engineSwitchRefusal,
  explicitTransportPhases,
  NativeSwitchConflict,
  resolveSwitches,
  sessionSwitchRefusal,
  type CrossSwitch,
  type StoreWriterPart,
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
    name: "nothing naming the sessions switch, the default boot",
    sessions: [],
    store: false,
    supervisor: false,
    cross: undefined,
    refusal: undefined,
  },
])("$name", ({ sessions, store, supervisor, cross, refusal }) => {
  expect(sessionSwitchRefusal({ sessions, store, supervisor, cross })).toBe(refusal);
});

test.each([
  { platform: false, supervisor: false, refusal: undefined },
  { platform: false, supervisor: true, refusal: undefined },
  { platform: true, supervisor: true, refusal: undefined },
  {
    platform: true,
    supervisor: false,
    refusal: "ACE_DEVICE_PLATFORM needs ACE_SUPERVISOR=native",
  },
])(
  "the device platform's supervisor need: $platform/$supervisor",
  ({ platform, supervisor, refusal }) => {
    expect(devicePlatformSwitchRefusal({ platform, supervisor })).toBe(refusal);
  },
);

interface EngineRefusalCase {
  name: string;
  engine: boolean;
  store: boolean;
  writer: readonly StoreWriterPart[];
  cross: CrossSwitch | undefined;
  refusal: string | undefined;
}

/**
 * A native engine needs the native store and its Rust transaction stack, and never a cross boot
 * on the store or its writer: a boot without that stack cannot host the engine.
 */
test.each<EngineRefusalCase>([
  {
    name: "a named engine without the native store",
    engine: true,
    store: false,
    writer: ["fold", "sequences", "events", "columns", "live", "transactions"],
    cross: undefined,
    refusal: "ACE_ENGINE needs ACE_STORE=native",
  },
  {
    name: "a named engine without the writer's transactions",
    engine: true,
    store: true,
    writer: ["fold", "sequences", "events", "columns", "live"],
    cross: undefined,
    refusal: "ACE_ENGINE needs ACE_STORE_WRITER=…,transactions",
  },
  {
    name: "a named engine under the writer's cross switch",
    engine: true,
    store: true,
    writer: ["fold", "sequences", "events", "columns", "live", "transactions"],
    cross: "ACE_STORE_WRITER",
    refusal: "ACE_NATIVE_CROSS=ACE_STORE_WRITER cannot run with ACE_ENGINE",
  },
  {
    name: "a named engine under the store's cross switch",
    engine: true,
    store: true,
    writer: ["fold", "sequences", "events", "columns", "live", "transactions"],
    cross: "ACE_STORE",
    refusal: "ACE_NATIVE_CROSS=ACE_STORE cannot run with ACE_ENGINE",
  },
  {
    name: "store and writer both missing, which names the store first",
    engine: true,
    store: false,
    writer: [],
    cross: undefined,
    refusal: "ACE_ENGINE needs ACE_STORE=native",
  },
  {
    name: "the cross gate naming the engine switch without a native store",
    engine: false,
    store: false,
    writer: [],
    cross: "ACE_ENGINE",
    refusal: "ACE_ENGINE needs ACE_STORE=native",
  },
  {
    name: "everything the engine needs is present",
    engine: true,
    store: true,
    writer: ["fold", "sequences", "events", "columns", "live", "transactions"],
    cross: undefined,
    refusal: undefined,
  },
])("$name", ({ engine, store, writer, cross, refusal }) => {
  expect(engineSwitchRefusal({ engine, store, writer: new Set(writer), cross })).toBe(refusal);
});

/** The variables a fresh switch module reads at load: the gate's and the writer's own. */
const switchKeys = ["ACE_STORE", "ACE_STORE_WRITER", "ACE_STORE_WRITER_CROSS"] as const;

/**
 * A fresh copy of the module, seen as a sibling process's boot: the cross log already holds
 * `seen` boots of this root, so this boot is boot `seen`.
 */
async function bootAfter(
  seen: number,
  env: Partial<Record<(typeof switchKeys)[number], string>>,
): Promise<typeof import("./native-switches.ts")> {
  const dir = mkdtempSync(join(tmpdir(), "ace-native-switches-"));
  const root = join(dir, "home");
  mkdirSync(root, { recursive: true });
  const log = join(dir, "boots.jsonl");
  writeFileSync(
    log,
    Array.from({ length: seen }, (_, n) =>
      JSON.stringify({ root, n, switch: "ACE_STORE_WRITER", backend: "", effective: "", pid: 1 }),
    )
      .map((line) => `${line}\n`)
      .join(""),
  );
  const saved = switchKeys.map((key) => [key, process.env[key]] as const);
  try {
    for (const key of switchKeys) delete process.env[key];
    Object.assign(process.env, env, {
      ACE_NATIVE_CROSS: "ACE_STORE_WRITER",
      ACE_NATIVE_CROSS_LOG: log,
    });
    vi.resetModules();
    const fresh = await import("./native-switches.ts");
    fresh.noteDatabaseBoot(join(root, "events.sqlite"));
    return fresh;
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const sortedParts = (parts: ReadonlySet<StoreWriterPart>) => [...parts].toSorted();

test("the starting-off writer cross run alternates on the starting-on parts, not on fold alone", async () => {
  const env = { ACE_STORE: "native", ACE_STORE_WRITER_CROSS: "fold,sequences" } as const;
  expect(sortedParts((await bootAfter(0, env)).storeWriterParts())).toEqual([]);
  expect(sortedParts((await bootAfter(1, env)).storeWriterParts())).toEqual(["fold", "sequences"]);
});

test.each([
  ["bogus", "ACE_STORE_WRITER_CROSS names an unknown part: bogus"],
  ["sequences", "ACE_STORE_WRITER_CROSS=sequences needs fold"],
])("ACE_STORE_WRITER_CROSS=%s refuses to start", async (value, message) => {
  await expect(
    bootAfter(0, { ACE_STORE: "native", ACE_STORE_WRITER_CROSS: value }),
  ).rejects.toThrow(message);
});

test.each([
  [" events, fold,sequences,fold ", "fold,sequences,events"],
  ["", ""],
  [undefined, ""],
])("writer parts %s are canonical as %s", (value, parts) => {
  expect(canonicalWriterParts(value)).toBe(parts);
});
