// SPDX-License-Identifier: Apache-2.0
/**
 * T1b.5's per-case evidence reader (`t1b-brief.md`, "The proof run, Autobahn and the bench").
 *
 * The on leg's `ACE_TRANSPORT_EVIDENCE` file holds one JSON line per line the native listeners
 * report (`native-transport.ts`): `bind`, `bind-failed`, `close-requested`, `close` with the
 * listener's counts, and `handled` with the counts since the previous line. Every line of a bound
 * listener carries the listener's **instance** id, so two listeners on one port in turn (a retry, a
 * restart) are never confused. The setup file (`transport-evidence-case.ts`) brackets every case
 * with `case` and `case-end` markers carrying a **unique id**, and flushes what its own process
 * handled. A daemon child inherits the same file, so its lines land in the case that started it.
 *
 * This module pairs each executed case with exactly one window (by name, first unused, never
 * reusing one), and credits a case only with what it owns: a `handled` line is a delta since the
 * previous line and so belongs to the case it lands in; a `close` line is a running total and
 * counts only when its listener's bind is inside the same window. Then it applies
 * `transport-evidence-rules.ts`: traffic, the counters a few cases owe, the lifecycle table, the
 * exemptions, and every bind's close, one listener instance at a time. A case the evidence cannot
 * prove is `NONE`.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  CASE_COUNTERS,
  EXEMPT_CASES,
  LIFECYCLE_CASES,
  TRAFFIC_FILES,
  type CaseCounter,
  type ExemptCase,
  type LifecycleCase,
} from "./transport-evidence-rules.ts";

/** One evidence line, as much of it as the checks read; every field is optional. */
export interface EvidenceLine {
  /** Its position in the file, so a rule can order two lines. */
  at?: number;
  pid?: number;
  listener?: string;
  port?: number;
  /** The listener's instance id: one from its bind to its close, unique in its process. */
  instance?: number;
  /** A case marker's unique id, never its title. */
  id?: string;
  event?: string;
  backend?: string;
  code?: string;
  bound?: boolean;
  name?: string;
  connections?: number;
  exchanges?: number;
  upgrades?: number;
  trustedHandshakes?: number;
  postQuantumHandshakes?: number;
  deflatedOut?: number;
  inflatedIn?: number;
}

/** The counters one listener instance reports. */
export interface Owned {
  connections: number;
  exchanges: number;
  upgrades: number;
  trustedHandshakes: number;
  postQuantumHandshakes: number;
  deflatedOut: number;
  inflatedIn: number;
}

/** Every counter, zeroed. */
function noCounts(): Owned {
  return {
    connections: 0,
    exchanges: 0,
    upgrades: 0,
    trustedHandshakes: 0,
    postQuantumHandshakes: 0,
    deflatedOut: 0,
    inflatedIn: 0,
  };
}

/** One listener's life in the file: its bind, its close, and every line it wrote. */
export interface ListenerInstance {
  instance: number;
  pid: number;
  listener: string;
  port: number;
  /** Its bind's position; -1 when no bind line named it. */
  bindAt: number;
  /** Its close's position; -1 when it never closed. */
  closeAt: number;
  close?: EvidenceLine;
  /** Every line of this instance, in file order. */
  lines: EvidenceLine[];
}

/** One case's lines, between its markers. */
interface Window {
  id?: string;
  name: string;
  start: number;
  end: number;
}

/** What one case's own markers and its listener instances give a rule to check. */
export interface WindowView {
  name: string;
  lines: readonly EvidenceLine[];
  /** The instances whose bind sits inside this window: the ones this case opened and closed. */
  bound: readonly ListenerInstance[];
  /** Every instance a line in this window names, bound here or not. */
  all: readonly ListenerInstance[];
  /** What this case owns, per instance: `handled` deltas, and in-window closes. */
  owned: ReadonlyMap<string, Owned>;
}

/** One case, its window's listeners, and the verdict the evidence supports. */
export interface CaseRow {
  name: string;
  verdict: "proven" | "exempt" | "NONE";
  /** The listeners and ports with their lifecycle events and counts. */
  listeners: string;
  /** Why a case is `NONE`, or why it is exempt. */
  detail?: string;
}

/** What a file's evidence proves, for the proof script's report and failures. */
export interface CaseEvidence {
  cases: CaseRow[];
  /** Each rule the evidence did not satisfy; the run exits non-zero on any. */
  findings: string[];
}

/** The key a rule names a test file by: T1a.8's label, `remote.server` for `remote.server.process.test.ts`. */
export function fileKey(file: string): string {
  return basename(file)
    .replace(/\.test\.ts$/, "")
    .replace(/\.server\.process$/, ".server");
}

/** Whether the rules name a case of this file: traffic, a counter or a lifecycle case. */
export function requiresCaseEvidence(file: string): boolean {
  const key = fileKey(file);
  return TRAFFIC_FILES.includes(key) || LIFECYCLE_CASES.some((entry) => entry.file === key);
}

/** A number field, or absent; anything else is refused. */
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A string field, or absent. */
function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** One decoded line, or undefined for a line this reader does not name. */
function decodeLine(value: unknown): EvidenceLine | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const fields = value as Record<string, unknown>;
  const event = text(fields["event"]);
  if (event === undefined) return undefined;
  const id = fields["id"];
  const decoded: EvidenceLine = {
    event,
    ...(number(fields["pid"]) !== undefined ? { pid: number(fields["pid"]) } : {}),
    ...(text(fields["listener"]) !== undefined ? { listener: text(fields["listener"]) } : {}),
    ...(number(fields["port"]) !== undefined ? { port: number(fields["port"]) } : {}),
    ...(number(fields["instance"]) !== undefined ? { instance: number(fields["instance"]) } : {}),
    ...(typeof id === "string" || typeof id === "number" ? { id: String(id) } : {}),
    ...(text(fields["backend"]) !== undefined ? { backend: text(fields["backend"]) } : {}),
    ...(text(fields["code"]) !== undefined ? { code: text(fields["code"]) } : {}),
    ...(typeof fields["bound"] === "boolean" ? { bound: fields["bound"] } : {}),
    ...(text(fields["name"]) !== undefined ? { name: text(fields["name"]) } : {}),
  };
  for (const counter of [
    "connections",
    "exchanges",
    "upgrades",
    "trustedHandshakes",
    "postQuantumHandshakes",
    "deflatedOut",
    "inflatedIn",
  ] as const) {
    const counted = number(fields[counter]);
    if (counted !== undefined) decoded[counter] = counted;
  }
  return decoded;
}

/** Every line the evidence file holds; a missing file is no lines, a bad line is skipped. */
export function readEvidence(path: string): EvidenceLine[] {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines: EvidenceLine[] = [];
  for (const raw of contents.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const line = decodeLine(value);
    if (line !== undefined) {
      line.at = lines.length;
      lines.push(line);
    }
  }
  return lines;
}

/** Whether the file has any listener line at all: case markers alone prove no native listener. */
export function hasListenerLine(path: string): boolean {
  return readEvidence(path).some(
    (line) =>
      line.listener !== undefined &&
      (line.event === "bind" ||
        line.event === "bind-failed" ||
        line.event === "close-requested" ||
        line.event === "close" ||
        line.event === "handled"),
  );
}

/** The case windows of one file, in the order the cases ran, each closed by its own id. */
function caseWindows(lines: readonly EvidenceLine[]): Window[] {
  const windows: Window[] = [];
  let open: Window | undefined;
  for (const [index, line] of lines.entries()) {
    if (line.event === "case") {
      // A case whose end never came (a crash) still has a window; a new case starts a new one.
      if (open !== undefined) open.end = index;
      open = {
        ...(line.id === undefined ? {} : { id: line.id }),
        name: line.name ?? "(unnamed)",
        start: index,
        end: lines.length,
      };
      windows.push(open);
      continue;
    }
    if (line.event === "case-end" && open !== undefined && line.id === open.id) {
      open.end = index;
      open = undefined;
    }
  }
  return windows;
}

/** The name's own segment, without the suites above it. */
function lastSegment(name: string): string {
  const parts = name.split(" > ");
  return parts[parts.length - 1] ?? name;
}

/** Whether a window's marker names this executed test. */
function windowMatches(window: Window, test: { fullName: string; title: string }): boolean {
  return (
    window.name === test.fullName ||
    window.name === test.title ||
    lastSegment(window.name) === test.title ||
    window.name.endsWith(` > ${test.fullName}`)
  );
}

/** One executed test and the one window it wrote. */
interface Pairing {
  test: { fullName: string; title: string };
  window?: Window;
  /** Why the pairing is not clean, when it is not. */
  problem?: string;
}

/**
 * Pairs executed tests with windows one to one. A name match wins; a duplicate title takes the
 * first window not already taken, in execution order, so two cases with one title never share a
 * window. A test whose name matches no window takes the next unused window in order and is
 * reported as a mismatch: the markers and the report disagree, which is not proof.
 */
function pairCases(
  windows: readonly Window[],
  executed: readonly { fullName: string; title: string }[],
): Pairing[] {
  const used = new Set<number>();
  const pairings: Pairing[] = [];
  for (const test of executed) {
    let match = -1;
    for (const [index, window] of windows.entries())
      if (!used.has(index) && windowMatches(window, test)) {
        match = index;
        break;
      }
    if (match >= 0) {
      used.add(match);
      pairings.push({ test, window: windows[match] });
      continue;
    }
    let fallback = -1;
    for (const index of windows.keys())
      if (!used.has(index)) {
        fallback = index;
        break;
      }
    if (fallback >= 0) {
      used.add(fallback);
      const window = windows[fallback];
      pairings.push({
        test,
        ...(window === undefined ? {} : { window }),
        problem: `its markers name "${window?.name ?? "(none)"}", not this case`,
      });
      continue;
    }
    pairings.push({ test, problem: "the evidence file has no window for this case" });
  }
  return pairings;
}

/** Every listener instance the file names, by `pid:instance`. */
export function listenerInstances(lines: readonly EvidenceLine[]): ListenerInstance[] {
  const found = new Map<string, ListenerInstance>();
  for (const line of lines) {
    if (line.instance === undefined || line.listener === undefined) continue;
    const key = `${String(line.pid)}:${String(line.instance)}`;
    const current = found.get(key) ?? {
      instance: line.instance,
      pid: line.pid ?? 0,
      listener: line.listener,
      port: line.port ?? 0,
      bindAt: -1,
      closeAt: -1,
      lines: [],
    };
    if (line.event === "bind") {
      current.bindAt = line.at ?? -1;
      if (line.port !== undefined) current.port = line.port;
    }
    if (line.event === "close") {
      current.closeAt = line.at ?? -1;
      current.close = line;
    }
    current.lines.push(line);
    found.set(key, current);
  }
  return [...found.values()];
}

/** Binds with no close of the same instance, and closes that precede their bind. */
function unpairedInstances(instances: readonly ListenerInstance[]): string[] {
  const findings: string[] = [];
  for (const listener of instances) {
    if (listener.bindAt < 0) continue;
    if (listener.closeAt < 0) {
      findings.push(
        `${listener.listener}:${String(listener.port)} (pid ${String(listener.pid)}, instance ${String(listener.instance)}) bound with no close of its own; its counts are unknown`,
      );
      continue;
    }
    if (listener.closeAt < listener.bindAt)
      findings.push(
        `${listener.listener}:${String(listener.port)} (instance ${String(listener.instance)}) closed before its bind`,
      );
  }
  return findings;
}

/** The counters one window owns, per listener instance. */
function ownedBy(
  lines: readonly EvidenceLine[],
  start: number,
  end: number,
  instances: readonly ListenerInstance[],
): Map<string, Owned> {
  const byKey = new Map(
    instances.map((listener) => [`${String(listener.pid)}:${String(listener.instance)}`, listener]),
  );
  const owned = new Map<string, Owned>();
  for (const line of lines) {
    if (line.at === undefined || line.at <= start || line.at >= end) continue;
    if (line.instance === undefined || line.listener === undefined) continue;
    const key = `${String(line.pid)}:${String(line.instance)}`;
    const listener = byKey.get(key);
    if (listener === undefined) continue;
    if (line.event === "handled") {
      const counts = owned.get(key) ?? noCounts();
      for (const counter of Object.keys(counts) as (keyof Owned)[])
        counts[counter] += line[counter] ?? 0;
      owned.set(key, counts);
      continue;
    }
    if (line.event !== "close") continue;
    // A close is a running total: it belongs to this case only when the whole listener did.
    if (listener.bindAt <= start || listener.bindAt >= end) continue;
    const counts = owned.get(key) ?? noCounts();
    for (const counter of Object.keys(counts) as (keyof Owned)[]) {
      const total = line[counter] ?? 0;
      counts[counter] = Math.max(counts[counter], total);
    }
    owned.set(key, counts);
  }
  return owned;
}

/** The listeners and ports of a window, with the events each reported and what it was credited. */
function listenersOf(view: WindowView): string {
  const groups = new Map<string, { events: string[]; counts: Owned }>();
  for (const line of view.lines) {
    if (line.listener === undefined || line.port === undefined || line.event === undefined)
      continue;
    const key = `${line.listener}:${String(line.port)}${line.instance === undefined ? "" : `#${String(line.instance)}`}`;
    const group = groups.get(key) ?? { events: [], counts: noCounts() };
    if (!group.events.includes(line.event)) group.events.push(line.event);
    groups.set(key, group);
  }
  for (const [key, counts] of view.owned) {
    const listener = view.all.find(
      (entry) => `${String(entry.pid)}:${String(entry.instance)}` === key,
    );
    if (listener === undefined) continue;
    const group = groups.get(
      `${listener.listener}:${String(listener.port)}#${String(listener.instance)}`,
    );
    if (group !== undefined) group.counts = counts;
  }
  const parts: string[] = [];
  for (const [key, group] of groups) {
    const numbers = [
      group.counts.connections ? `conn=${group.counts.connections}` : "",
      group.counts.exchanges ? `ex=${group.counts.exchanges}` : "",
      group.counts.upgrades ? `up=${group.counts.upgrades}` : "",
      group.counts.deflatedOut ? `deflatedOut=${group.counts.deflatedOut}` : "",
      group.counts.inflatedIn ? `inflatedIn=${group.counts.inflatedIn}` : "",
      group.counts.trustedHandshakes ? `trusted=${group.counts.trustedHandshakes}` : "",
      group.counts.postQuantumHandshakes ? `pq=${group.counts.postQuantumHandshakes}` : "",
    ].filter(Boolean);
    parts.push(
      `${key} ${group.events.join(",")}${numbers.length ? ` (${numbers.join(" ")})` : ""}`,
    );
  }
  return parts.length ? parts.join("; ") : "no listener";
}

/** Whether the file has a loopback close line with work behind it (T1a.8's file-level rule). */
function loopbackServed(instances: readonly ListenerInstance[]): boolean {
  return instances.some(
    (listener) =>
      listener.listener === "loopback" &&
      listener.close !== undefined &&
      (listener.close.exchanges ?? 0) + (listener.close.upgrades ?? 0) > 0,
  );
}

/** Whether a case owns remote traffic: a remote instance this case opened, or a delta it took. */
function trafficOwned(view: WindowView): boolean {
  for (const [key, counts] of view.owned) {
    const listener = view.all.find(
      (entry) => `${String(entry.pid)}:${String(entry.instance)}` === key,
    );
    if (listener?.listener !== "remote") continue;
    if (counts.connections > 0 && counts.exchanges + counts.upgrades > 0) return true;
  }
  return false;
}

/** Whether a case owns the counter it owes, on a remote listener. */
function counterOwned(view: WindowView, counter: CaseCounter["counter"]): boolean {
  for (const [key, counts] of view.owned) {
    const listener = view.all.find(
      (entry) => `${String(entry.pid)}:${String(entry.instance)}` === key,
    );
    if (listener?.listener !== "remote") continue;
    if (counts[counter] > 0) return true;
  }
  return false;
}

/** The exemption for a case of this file, when it is named. */
function exemptionFor(key: string, title: string): ExemptCase | undefined {
  return EXEMPT_CASES.find((entry) => entry.file === key && entry.title === title);
}

/** The lifecycle rule for a case of this file, when it is in the table. */
function lifecycleFor(key: string, title: string): LifecycleCase | undefined {
  return LIFECYCLE_CASES.find((entry) => entry.file === key && entry.title === title);
}

/** The counter rule for a case of this file, when it owes one. */
function counterFor(key: string, title: string): CaseCounter | undefined {
  return CASE_COUNTERS.find((entry) => entry.file === key && entry.title === title);
}

/**
 * One file's case evidence: every executed case paired with its own window and checked against the
 * rules for its file, plus the file-level rules (every bind closed, one instance at a time; a
 * loopback close with work for a file no traffic rule names).
 */
export function caseEvidence(
  file: string,
  evidencePath: string,
  executed: readonly { fullName: string; title: string }[],
): CaseEvidence {
  const key = fileKey(file);
  const lines = readEvidence(evidencePath);
  const windows = caseWindows(lines);
  const instances = listenerInstances(lines);
  const pairings = pairCases(windows, executed);
  const findings = unpairedInstances(instances);
  const rows: CaseRow[] = [];
  const traffic = TRAFFIC_FILES.includes(key);

  for (const pairing of pairings) {
    const { test } = pairing;
    if (pairing.window === undefined) {
      rows.push({
        name: test.title,
        verdict: "NONE",
        listeners: "no case markers",
        detail: pairing.problem ?? "the evidence file has no window for this case",
      });
      findings.push(`${test.title}: ${pairing.problem ?? "no case markers"}`);
      continue;
    }
    const window = pairing.window;
    const view: WindowView = {
      name: window.name,
      lines: lines.slice(window.start + 1, window.end),
      bound: instances.filter(
        (listener) => listener.bindAt > window.start && listener.bindAt < window.end,
      ),
      all: instances.filter((listener) =>
        listener.lines.some(
          (line) => (line.at ?? -1) > window.start && (line.at ?? -1) < window.end,
        ),
      ),
      owned: ownedBy(lines, window.start, window.end, instances),
    };
    const listeners = listenersOf(view);
    if (pairing.problem !== undefined) {
      rows.push({ name: test.title, verdict: "NONE", listeners, detail: pairing.problem });
      findings.push(`${test.title}: ${pairing.problem} (evidence: ${listeners})`);
      continue;
    }
    const exempt = exemptionFor(key, test.title);
    const lifecycle = lifecycleFor(key, test.title);
    const counter = counterFor(key, test.title);
    if (exempt !== undefined) {
      rows.push({ name: test.title, verdict: "exempt", listeners, detail: exempt.reason });
      continue;
    }
    if (lifecycle !== undefined) {
      const failure = lifecycle.check(view);
      rows.push({
        name: test.title,
        verdict: failure === undefined ? "proven" : "NONE",
        listeners,
        detail: failure ?? lifecycle.proof,
      });
      if (failure !== undefined)
        findings.push(`${test.title}: ${failure} (evidence: ${listeners})`);
      continue;
    }
    if (traffic) {
      if (!trafficOwned(view)) {
        rows.push({
          name: test.title,
          verdict: "NONE",
          listeners,
          detail: "no remote traffic this case owns",
        });
        findings.push(
          `${test.title}: no remote handled delta or in-window close with connections and exchanges (evidence: ${listeners})`,
        );
        continue;
      }
      if (counter !== undefined && !counterOwned(view, counter.counter)) {
        rows.push({
          name: test.title,
          verdict: "NONE",
          listeners,
          detail: `no ${counter.counter}`,
        });
        findings.push(
          `${test.title}: its window shows no ${counter.counter} (evidence: ${listeners})`,
        );
        continue;
      }
      rows.push({
        name: test.title,
        verdict: "proven",
        listeners,
        detail: counter === undefined ? "remote traffic" : `remote traffic and ${counter.counter}`,
      });
      continue;
    }
    rows.push({
      name: test.title,
      verdict: "proven",
      listeners,
      detail: "no case rule for this file",
    });
  }

  // A file no traffic rule names keeps T1a.8's file-level rule, read from its close lines. A file
  // whose cases are all in the lifecycle table is proved by that table instead.
  const lifecycleOnly = LIFECYCLE_CASES.some((entry) => entry.file === key);
  if (!traffic && !lifecycleOnly && !loopbackServed(instances))
    findings.push("no loopback close line with exchanges or upgrades");

  return { cases: rows, findings };
}

/** The per-case table, for the PR and the console. */
export function caseTable(file: string, evidence: CaseEvidence): string[] {
  const rows = [`  ${file}`];
  for (const row of evidence.cases)
    rows.push(
      `    ${row.verdict.padEnd(7)} ${row.name}${row.detail ? ` — ${row.detail}` : ""} [${row.listeners}]`,
    );
  return rows;
}
