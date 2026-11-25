// SPDX-License-Identifier: Apache-2.0
/**
 * T1b.5's per-case evidence reader (`t1b-brief.md`, "The proof run, Autobahn and the bench").
 *
 * The on leg's `ACE_TRANSPORT_EVIDENCE` file holds one JSON line per line the native listeners
 * report (`native-transport.ts`): `bind`, `bind-failed`, `close-requested`, `close` with the
 * listener's counts, and `handled` with the counts since the previous line. The setup file
 * (`transport-evidence-case.ts`) brackets every case with `case` and `case-end`, and flushes what
 * its own process handled. That makes the lines between a case's markers that case's, a daemon
 * child's included: a child inherits the same evidence file.
 *
 * This module reads those lines, pairs each executed case with its window, and applies the rules
 * in `transport-evidence-rules.ts`: traffic, the counters a few cases owe, the lifecycle table,
 * the exemptions, and every bind's close. A case the evidence cannot prove is `NONE`.
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
  pid?: number;
  listener?: string;
  port?: number;
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
  const decoded: EvidenceLine = {
    event,
    ...(number(fields["pid"]) !== undefined ? { pid: number(fields["pid"]) } : {}),
    ...(text(fields["listener"]) !== undefined ? { listener: text(fields["listener"]) } : {}),
    ...(number(fields["port"]) !== undefined ? { port: number(fields["port"]) } : {}),
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
    if (line !== undefined) lines.push(line);
  }
  return lines;
}

/** A case's lines, between its markers. */
interface Window {
  name: string;
  lines: EvidenceLine[];
}

/** The case windows of one file, in the order the cases ran. */
function caseWindows(lines: readonly EvidenceLine[]): Window[] {
  const windows: Window[] = [];
  let open: Window | undefined;
  for (const line of lines) {
    if (line.event === "case") {
      open = { name: line.name ?? "(unnamed)", lines: [] };
      windows.push(open);
      continue;
    }
    if (line.event === "case-end") {
      open = undefined;
      continue;
    }
    open?.lines.push(line);
  }
  return windows;
}

/** The name's own segment, without the suites above it. */
function lastSegment(name: string): string {
  const parts = name.split(" > ");
  return parts[parts.length - 1] ?? name;
}

/** The window an executed test wrote, by full name, title, or the title inside the suites. */
function findWindow(
  windows: readonly Window[],
  fullName: string,
  title: string,
): Window | undefined {
  return (
    windows.find((window) => window.name === fullName) ??
    windows.find((window) => window.name === title) ??
    windows.find((window) => lastSegment(window.name) === title) ??
    windows.find((window) => window.name.endsWith(` > ${fullName}`))
  );
}

/** Whether a line carries the traffic a traffic case owes. */
function carried(line: EvidenceLine): boolean {
  return (
    line.listener === "remote" &&
    (line.event === "handled" || line.event === "close") &&
    (line.connections ?? 0) > 0 &&
    (line.exchanges ?? 0) + (line.upgrades ?? 0) > 0
  );
}

/** The listeners and ports of a window, with the events each reported and its last counts. */
function listenersOf(window: readonly EvidenceLine[]): string {
  const groups = new Map<string, { events: string[]; counts: EvidenceLine }>();
  for (const line of window) {
    if (line.listener === undefined || line.port === undefined || line.event === undefined)
      continue;
    const key = `${line.listener}:${line.port}`;
    const group = groups.get(key) ?? { events: [], counts: {} };
    if (!group.events.includes(line.event)) group.events.push(line.event);
    if (line.event === "close" || line.event === "handled")
      group.counts = { ...group.counts, ...line };
    groups.set(key, group);
  }
  const parts: string[] = [];
  for (const [key, group] of groups) {
    const counts = group.counts;
    const numbers = [
      counts.connections !== undefined ? `conn=${counts.connections}` : "",
      counts.exchanges !== undefined ? `ex=${counts.exchanges}` : "",
      counts.upgrades !== undefined ? `up=${counts.upgrades}` : "",
      counts.deflatedOut ? `deflatedOut=${counts.deflatedOut}` : "",
      counts.inflatedIn ? `inflatedIn=${counts.inflatedIn}` : "",
      counts.trustedHandshakes ? `trusted=${counts.trustedHandshakes}` : "",
      counts.postQuantumHandshakes ? `pq=${counts.postQuantumHandshakes}` : "",
    ].filter(Boolean);
    parts.push(
      `${key} ${group.events.join(",")}${numbers.length ? ` (${numbers.join(" ")})` : ""}`,
    );
  }
  return parts.length ? parts.join("; ") : "no listener";
}

/** Every bind of the file has a later close with the same pid, listener and port. */
function unclosedBinds(lines: readonly EvidenceLine[]): EvidenceLine[] {
  const unclosed: EvidenceLine[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.event !== "bind" || line.listener === undefined || line.port === undefined) continue;
    const closed = lines
      .slice(index + 1)
      .some(
        (later) =>
          later.event === "close" &&
          later.pid === line.pid &&
          later.listener === line.listener &&
          later.port === line.port,
      );
    if (!closed) unclosed.push(line);
  }
  return unclosed;
}

/** Whether the file has a loopback close line with work behind it (T1a.8's file-level rule). */
function loopbackServed(lines: readonly EvidenceLine[]): boolean {
  return lines.some(
    (line) =>
      line.event === "close" &&
      line.listener === "loopback" &&
      (line.exchanges ?? 0) + (line.upgrades ?? 0) > 0,
  );
}

/** The counter a case owes, over its window's `handled` deltas and `close` totals. */
function counterShown(window: readonly EvidenceLine[], counter: CaseCounter["counter"]): boolean {
  return window.some((line) => (line[counter] ?? 0) > 0);
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
 * One file's case evidence: every executed case paired with its window and checked against the
 * rules for its file, plus the file-level rules (every bind closed; a loopback close with work
 * for a file no case rule names).
 */
export function caseEvidence(
  file: string,
  evidencePath: string,
  executed: readonly { fullName: string; title: string }[],
): CaseEvidence {
  const key = fileKey(file);
  const lines = readEvidence(evidencePath);
  const windows = caseWindows(lines);
  const findings: string[] = [];
  const rows: CaseRow[] = [];
  const traffic = TRAFFIC_FILES.includes(key);

  for (const line of unclosedBinds(lines))
    findings.push(
      `${line.listener}:${String(line.port)} (pid ${String(line.pid)}) bound with no close line; its counts are unknown`,
    );

  for (const test of executed) {
    const window = findWindow(windows, test.fullName, test.title);
    if (window === undefined) {
      rows.push({
        name: test.title,
        verdict: "NONE",
        listeners: "no case markers",
        detail: "the evidence file has no window for this case",
      });
      findings.push(`${test.title}: no case markers in the evidence file`);
      continue;
    }
    const exempt = exemptionFor(key, test.title);
    const lifecycle = lifecycleFor(key, test.title);
    const counter = counterFor(key, test.title);
    const listeners = listenersOf(window.lines);
    if (exempt !== undefined) {
      rows.push({ name: test.title, verdict: "exempt", listeners, detail: exempt.reason });
      continue;
    }
    if (lifecycle !== undefined) {
      const failure = lifecycle.check(window.lines);
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
      if (!window.lines.some(carried)) {
        rows.push({
          name: test.title,
          verdict: "NONE",
          listeners,
          detail: "no remote traffic in the case",
        });
        findings.push(
          `${test.title}: no remote handled or close line with connections and exchanges (evidence: ${listeners})`,
        );
        continue;
      }
      if (counter !== undefined && !counterShown(window.lines, counter.counter)) {
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
  // whose cases are all in the lifecycle table is proved by that table instead: its cases open a
  // listener and close it around the work, and never carry an exchange (T1b.5's `remote-direct`).
  const lifecycleOnly = LIFECYCLE_CASES.some((entry) => entry.file === key);
  if (!traffic && !lifecycleOnly && !loopbackServed(lines))
    findings.push("no loopback close line with exchanges or upgrades");

  return { cases: rows, findings };
}

/** The per-case table, for the PR and the console. */
export function caseTable(file: string, evidence: CaseEvidence): string[] {
  const rows = [`  ${file}`];
  for (const row of evidence.cases)
    rows.push(`    ${row.verdict.padEnd(7)} ${row.name}${row.detail ? ` — ${row.detail}` : ""}`);
  return rows;
}
