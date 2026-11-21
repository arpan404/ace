import { chromium, type Page } from "@playwright/test";
import { expect, inject, test } from "vitest";
import { withEditorMachine } from "./editor-daemon.ts";
import {
  installEditorProbe,
  loadOutcome,
  nextSwitch,
  quantile,
  readProbe,
} from "./editor-probe.ts";

/*
 * The editor's performance budget (docs/editor/workbench.md 59), against a real daemon on a
 * temporary checkout: 100 open tabs over 200,000-line files, in 2 groups.
 *
 * Each file is about 1 MB, so the 100 together are over the registry's 64 MB cap and the cap
 * has to free hidden buffers. The run opens every tab once in order (oldest shown first), then
 * walks them back from the newest: the newest are still resident, the oldest were freed, so one
 * walk gives both kinds of switch. Which kind each was is what the page showed: a freed buffer
 * shows the group's loading state before its rows. The registry's own byte count isn't reachable
 * from the production page, so the cap is checked by what it leaves resident: the files whose
 * switch found their buffer resident (the shown editors among them, since the walk starts from
 * them), times the file size, are within the cap, and some switches found theirs freed.
 */

const lines = 200_000;
const capBytes = 64 * 1024 * 1024;
const budget = { resident: 50, evicted: 150, key: 16, load: 300 };

const paths = Array.from({ length: 100 }, (_, i) => `src/f${String(i).padStart(3, "0")}.ts`);
const left = paths.slice(0, 50);
const right = paths.slice(50);

/** A 200,000-line file of about 1 MB whose first line names it. */
function source(index: number): string {
  const rows = [`// file ${index}`];
  for (let line = 1; line < lines; line++) rows.push(`x=${line % 100}`);
  return `${rows.join("\n")}\n`;
}
const fileBytes = Buffer.byteLength(source(0));

function group(id: string, tabs: string[]) {
  return {
    kind: "group",
    id,
    tabs: tabs.map((path) => ({ path, preview: false, pinned: false })),
    active: tabs[0],
    mru: tabs,
  };
}

/** The thread's side panel as the workspace store keeps it: the editor, expanded, two groups. */
function storedWorkspace(threadId: string) {
  const layout = {
    root: {
      kind: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [group("g1", left), group("g2", right)],
    },
    focused: "g1",
    explorer: { open: false },
    closed: [],
  };
  const editor = { key: "editor", kind: "editor", id: "editor", pinned: false, data: layout };
  return {
    preferred: { right: 520 },
    scopes: [[threadId, { tabs: [editor], active: "editor", open: true, expanded: true }]],
  };
}

const groupNumber = (path: string) => (left.includes(path) ? 1 : 2);
const groupOf = (page: Page, path: string) =>
  page.getByRole("region", { name: `Group ${groupNumber(path)}`, exact: true });

/** Shows `path` by its tab, as a person clicks it; the switch the page measured. */
async function show(page: Page, path: string) {
  const index = (await readProbe(page)).switches.length;
  await groupOf(page, path).locator(`[role="tab"][data-path="${path}"]`).click();
  return nextSwitch(page, index);
}

/** Shows `path`, pressing Try again while its read fails (the daemon refused it as busy). */
async function showRecovering(page: Page, path: string) {
  let shown = await show(page, path);
  const refusals: string[] = [];
  for (let attempt = 0; shown.error !== undefined && attempt < 5; attempt++) {
    refusals.push(shown.error);
    const index = (await readProbe(page)).switches.length;
    await groupOf(page, path).getByRole("button", { name: "Try again" }).click();
    shown = await nextSwitch(page, index);
  }
  if (shown.error !== undefined) throw new Error(`${path} never opened: ${shown.error}`);
  return refusals;
}

test(
  "the editor with 100 tabs over 200,000-line files in 2 groups keeps its switch, typing and reload budgets",
  async () => {
    const files = paths.map((path, index): [string, string] => [path, source(index)]);
    await withEditorMachine(files, async ({ origin, daemon, threadId }) => {
      const browser = await chromium.launch({ executablePath: inject("chromiumExecutable") });
      try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
        page.on("dialog", (dialog) => void dialog.accept());
        // The first load only: after it, the app keeps its own storage across the reload.
        await page.addInitScript(
          ({ target, workspace }) => {
            if (sessionStorage.getItem("ace.editor-perf.seeded")) return;
            sessionStorage.setItem("ace.editor-perf.seeded", "1");
            localStorage.setItem("ace.daemon.url", target.url);
            localStorage.setItem("ace.daemon.token", target.token);
            localStorage.setItem("ace.workspace", JSON.stringify(workspace));
          },
          { target: daemon, workspace: storedWorkspace(threadId) },
        );
        await page.addInitScript(installEditorProbe);
        await page.goto(`${origin}/t/${threadId}`);
        const firstLoad = await loadOutcome(page);

        // Every tab once, oldest first; reads the daemon refused are retried as a person would.
        const refused: Record<string, string[]> = {};
        for (const path of [...left, ...right]) {
          const refusals = await showRecovering(page, path);
          if (refusals.length > 0) refused[path] = refusals;
        }

        // Back from the newest: resident buffers first, then ones the cap freed.
        const walk = [];
        for (const path of [...right.toReversed(), ...left.toReversed()])
          walk.push(await show(page, path));
        const resident = walk.filter((each) => !each.loading && each.error === undefined);
        const evicted = walk.filter((each) => each.loading && each.error === undefined);
        const failed = walk.filter((each) => each.error !== undefined);

        // Typing in the left group's shown editor.
        await page.getByRole("region", { name: `Source of ${left[0]}` }).click();
        const keysBefore = (await readProbe(page)).keys.length;
        await page.keyboard.type("const typed = 1; ".repeat(12), { delay: 30 });
        const keys = (await readProbe(page)).keys.slice(keysBefore);
        await page.keyboard.press("ControlOrMeta+s");
        await page.waitForTimeout(1_000);

        // Reload: the layout the app stored comes back and the shown editors paint.
        await page.reload();
        const reload = await loadOutcome(page);
        const reloadMs =
          reload.paintedAt !== undefined && reload.connectedAt !== undefined
            ? reload.paintedAt - reload.connectedAt
            : Infinity;

        const report = {
          fileBytes,
          firstLoad,
          refusedWhileOpening: Object.keys(refused).length,
          refusals: Object.values(refused).flat().slice(0, 3),
          residentSwitch: {
            samples: resident.length,
            p95: quantile(
              resident.map((s) => s.ms),
              0.95,
            ),
          },
          evictedSwitch: {
            samples: evicted.length,
            p95: quantile(
              evicted.map((s) => s.ms),
              0.95,
            ),
          },
          failedSwitches: failed.map((s) => `${s.path}: ${s.error}`),
          keyToPaint: { samples: keys.length, p95: quantile(keys, 0.95) },
          reload: { ...reload, ms: reloadMs },
          // The walk starts from the two shown editors, so they are among these already.
          residentBytesAtMost: new Set(resident.map((each) => each.path)).size * fileBytes,
        };
        process.stdout.write(`Editor budgets: ${JSON.stringify(report, null, 2)}\n`);

        expect.soft(failed, "switches whose file didn't open").toEqual([]);
        expect.soft(resident.length, "switches to a resident buffer").toBeGreaterThan(0);
        expect.soft(report.residentSwitch.p95).toBeLessThan(budget.resident);
        expect.soft(evicted.length, "switches to a buffer the cap freed").toBeGreaterThan(0);
        expect.soft(report.evictedSwitch.p95).toBeLessThan(budget.evicted);
        expect.soft(keys.length, "keys measured").toBeGreaterThan(100);
        expect.soft(report.keyToPaint.p95).toBeLessThan(budget.key);
        expect.soft(reload.errors, "editors that failed to open after the reload").toEqual([]);
        expect
          .soft(reloadMs, "reload to painted editors after the daemon connects")
          .toBeLessThan(budget.load);
        expect
          .soft(report.residentBytesAtMost, "resident buffer text")
          .toBeLessThanOrEqual(capBytes);
      } finally {
        await browser.close();
      }
    });
  },
  20 * 60_000,
);
