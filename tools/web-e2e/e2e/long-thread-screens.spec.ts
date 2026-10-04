import { mkdirSync } from "node:fs";
import { test, type Page } from "@playwright/test";

/**
 * The long-thread screens against the fake daemon, in Dark and Light at 1440x900, to
 * /tmp/aceshots-web/long-<screen>-<theme>.png: the turn timeline, a jumped view with Jump to
 * live, search with its hits, the catch-up card and older turns folded to digests. Run on
 * demand with the other screens: `bun run --filter @ace/web-e2e screens`.
 */
const out = process.env.ACE_SHOTS_DIR ?? "/tmp/aceshots-web";
mkdirSync(out, { recursive: true });

type Setup = (page: Page) => Promise<void>;
const mod = "ControlOrMeta";
const longThread = "/t/thread-multi-day";

/** The five-day thread as this device returns to it: the catch-up card first. */
async function returnToThread(page: Page) {
  await page.goto(longThread);
  await page.getByRole("feed", { name: "Transcript" }).waitFor();
  await page.getByRole("region", { name: "While you were away" }).waitFor();
}
async function openThread(page: Page) {
  await returnToThread(page);
  await page
    .getByRole("region", { name: "While you were away" })
    .getByRole("button", { name: "Dismiss" })
    .click();
}
async function openTurns(page: Page) {
  await page.getByRole("button", { name: "Turns" }).click();
  await page.getByRole("option", { name: /^Turn 24: / }).waitFor();
}

/**
 * A week of short release-triage turns (a test run, an edit, an answer; every fourth run
 * failing), so the transcript's own window holds a dozen turns and the older ones fold.
 */
const triage = `
  const id = "thread-release-triage";
  const day = 24 * 60 * 60 * 1000;
  daemon.createThread({ id, workspaceId: "ace", title: "Release triage: a week of nightly checks", provider: "codex" }, 6 * day);
  daemon.apply(id, [{ type: "agent.seen", agent: "root", origin: "root", fidelity: "full", native: { provider: "codex", nativeId: "root" }, cwd: "/Users/dev/ace" }], 6 * day);
  const packages = ["relay", "client", "projection", "daemon", "web", "conductor"];
  for (let n = 1; n <= 12; n++) {
    const pkg = packages[n % packages.length];
    const failed = n % 4 === 0;
    const ago = (13 - n) * 11 * 60 * 60 * 1000;
    const worked = (4 + (n * 7) % 19) * 60 * 1000;
    daemon.apply(id, [
      { type: "item.upsert", agent: "root", item: "ask-" + n, draft: { type: "message", role: "user", complete: true, parts: [{ type: "text", text: "Night " + n + ": run the " + pkg + " suite and fix what broke." }] } },
      { type: "turn.started", agent: "root", nativeTurnId: "turn-" + n, trigger: "user" },
      { type: "item.upsert", agent: "root", item: "test-" + n, draft: { type: "tool_call", complete: false, call: { kind: "shell", title: "bun run test packages/" + pkg, status: "running", raw: [], detail: { kind: "shell", command: "bun run test packages/" + pkg } } } },
    ], ago);
    daemon.apply(id, [
      { type: "item.upsert", agent: "root", item: "test-" + n, draft: { type: "tool_call", complete: true, call: { status: failed ? "failed" : "succeeded", detail: { kind: "shell", exitCode: failed ? 1 : 0 } } } },
      { type: "item.upsert", agent: "root", item: "edit-" + n, draft: { type: "tool_call", complete: false, call: { kind: "file.edit", title: "Edit packages/" + pkg + "/src/index.ts", status: "running", raw: [], detail: { kind: "file.edit", changes: [{ path: "packages/" + pkg + "/src/index.ts", kind: "update", diff: "@@ -1 +1,2 @@\\n-old\\n+fixed\\n+checked\\n" }] } } } },
      { type: "item.upsert", agent: "root", item: "edit-" + n, draft: { type: "tool_call", complete: true, call: { status: "succeeded" } } },
      { type: "item.upsert", agent: "root", item: "answer-" + n, draft: { type: "message", role: "assistant", complete: true, parts: [{ type: "text", text: failed ? "The " + pkg + " suite failed once on a timing assumption; the fix waits for the ack instead." : "The " + pkg + " suite passes; nothing else changed tonight." }] } },
      { type: "turn.ended", agent: "root", nativeTurnId: "turn-" + n, outcome: "completed" },
    ], ago - worked);
  }
`;
const staged =
  (stage: string, then: Setup): Setup =>
  async (page) => {
    await page.addInitScript((body) => {
      Object.assign(globalThis, { aceFakeSetup: new Function("daemon", body) });
    }, stage);
    await then(page);
  };

const screens: Record<string, Setup> = {
  "long-catch-up": async (page) => {
    await returnToThread(page);
    await page.mouse.move(700, 880);
  },
  "long-timeline": async (page) => {
    await openThread(page);
    await openTurns(page);
    for (let n = 0; n < 3; n++) await page.keyboard.press("ArrowUp");
  },
  "long-jumped": async (page) => {
    await openThread(page);
    await openTurns(page);
    await page.keyboard.press("Home");
    for (let n = 0; n < 6; n++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.getByRole("status", { name: "Jumped" }).waitFor();
    await page.keyboard.press("Escape");
    // Read on a little, so the gap to live and Jump to live both show.
    await page.getByRole("feed", { name: "Transcript" }).hover();
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(1_800);
    await page.mouse.move(700, 880);
  },
  "long-search": async (page) => {
    await openThread(page);
    await page.keyboard.press(`${mod}+f`);
    await page.keyboard.type("validation failed");
    const bar = page.getByRole("search", { name: "Search this thread" });
    await bar.getByText("3 results").waitFor();
    // The first hit opened in the transcript, then the list again over it.
    await page.keyboard.press("Enter");
    await page.getByRole("status", { name: "Jumped" }).waitFor();
    await bar.getByRole("textbox", { name: "Search this thread" }).click();
    await bar.getByRole("listbox", { name: "Results" }).waitFor();
  },
  "long-folded": staged(triage, async (page) => {
    await page.goto("/t/thread-release-triage");
    const feed = page.getByRole("feed", { name: "Transcript" });
    await feed.waitFor();
    await feed.getByRole("button", { name: /^Turn 3: / }).waitFor();
    await feed.hover();
    await page.mouse.wheel(0, -3_000);
    await page.waitForTimeout(400);
    await page.mouse.move(700, 880);
  }),
};

for (const theme of ["dark", "light"] as const)
  for (const [name, setup] of Object.entries(screens))
    test(`${name} in ${theme}`, async ({ page }) => {
      await page.addInitScript((id) => {
        if (!localStorage.getItem("ace.appearance"))
          localStorage.setItem("ace.appearance", JSON.stringify({ theme: id }));
      }, theme);
      await setup(page);
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${out}/${name}-${theme}.png` });
    });
