import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadListEntry, type ThreadStatus } from "@ace/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { paint } from "../tui/paint.ts";
import {
  homeCachePath,
  keepRows,
  keptRecord,
  keptRows,
  readKeptRows,
  rowsFromRecord,
} from "./home-cache.ts";
import { homeRows } from "./home-rows.ts";
import { homeStart } from "./home-state.ts";
import { homeView } from "./home-view.ts";

const now = 10_000_000;

function entry(id: string, status: ThreadStatus, extra: Record<string, unknown> = {}) {
  return ThreadListEntry.parse({
    workspaceId: "ace",
    title: `Thread ${id}`,
    provider: "claude",
    createdAt: 1,
    updatedAt: now - 60_000,
    hasSentMessage: true,
    details: { branch: `ace/${id}` },
    ...extra,
    id,
    status,
  });
}

const liveRows = (...entries: ThreadListEntry[]) =>
  homeRows({ entries, now, unconfirmed: false, projectName: (id) => `project ${id}` });

const firstFrame = (record: string) =>
  homeView(
    homeStart,
    {
      rows: rowsFromRecord(record),
      loading: true,
      requests: 0,
      tree: undefined,
      connection: "Connecting…",
    },
    100,
    30,
    paint(false),
  ).join("\n");

describe("the home's kept rows", () => {
  it("draw every kept thread as Syncing, never done, working or waiting on the person", () => {
    const record = keptRecord(
      liveRows(
        entry("done", { state: "done" }),
        entry("works", { state: "working", agents: 1 }),
        entry("asks", { state: "needs_you", interactions: 1 }),
      ),
    );
    const rows = rowsFromRecord(record);
    expect(rows.map((row) => row.id).toSorted()).toEqual(["asks", "done", "works"]);
    for (const row of rows) {
      expect(row).toMatchObject({ state: "syncing", time: "Syncing", glyph: " " });
      expect(row.needsYou).toBe(false);
      expect(row.running).toBe(false);
    }
    const frame = firstFrame(record);
    expect(frame).toContain("Connecting…");
    expect(frame).toContain("Thread done");
    expect(frame).toContain("ace/works");
    for (const mark of ["✓", "◌", "◆", "needs you", "running"]) expect(frame).not.toContain(mark);
  });

  it("keep what each row is, in the live list's order", () => {
    const live = liveRows(
      entry("rest", { state: "done" }, { updatedAt: now - 1000 }),
      entry("asks", { state: "needs_you", interactions: 1 }),
    );
    const kept = rowsFromRecord(keptRecord(live));
    expect(kept.map((row) => [row.id, row.title, row.project, row.branch, row.provider])).toEqual(
      live.map((row) => [row.id, row.title, row.project, row.branch, row.provider]),
    );
  });

  it("stay small: only the first rows are kept", () => {
    const many = Array.from({ length: keptRows + 25 }, (_, index) =>
      entry(`t${index}`, { state: "done" }, { updatedAt: now - index * 1000 }),
    );
    const live = liveRows(...many);
    const kept = rowsFromRecord(keptRecord(live));
    expect(kept.length).toBe(keptRows);
    expect(kept.map((row) => row.id)).toEqual(live.slice(0, keptRows).map((row) => row.id));
  });

  it.each([
    ["not JSON", "{"],
    ["another version", JSON.stringify({ version: 2, rows: [{ id: "t1", title: "x" }] })],
    ["no rows", JSON.stringify({ version: 1 })],
  ])("give no rows from a record that is %s", (_, record) => {
    expect(rowsFromRecord(record)).toEqual([]);
    expect(firstFrame(record)).toContain("Reading your threads…");
  });

  it("skip a kept row without an id or title and keep the rest", () => {
    const record = JSON.stringify({
      version: 1,
      rows: [{ title: "no id" }, { id: "t2" }, { id: "t3", title: "Kept", provider: 7 }],
    });
    expect(rowsFromRecord(record).map((row) => [row.id, row.title, row.provider])).toEqual([
      ["t3", "Kept", ""],
    ]);
  });
});

describe("the kept rows on disk", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });
  const home = () => {
    const made = mkdtempSync(join(tmpdir(), "ace-home-rows-"));
    homes.push(made);
    return made;
  };

  it("come back on the next run, readable only by the person", () => {
    const dir = home();
    keepRows(dir, liveRows(entry("t1", { state: "working", agents: 1 })));
    expect(readKeptRows(dir).map((row) => [row.id, row.time])).toEqual([["t1", "Syncing"]]);
    if (process.platform !== "win32") expect(statSync(homeCachePath(dir)).mode & 0o777).toBe(0o600);
  });

  it("are none on a first run or when the file was damaged", () => {
    const dir = home();
    expect(readKeptRows(dir)).toEqual([]);
    writeFileSync(homeCachePath(dir), "\u0000garbage");
    expect(readKeptRows(dir)).toEqual([]);
  });

  it("are skipped quietly when the home can't be written", () => {
    const missing = join(home(), "not-there");
    expect(() => keepRows(missing, liveRows(entry("t1", { state: "done" })))).not.toThrow();
    expect(readKeptRows(missing)).toEqual([]);
  });
});
