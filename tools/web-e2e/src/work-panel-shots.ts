import {
  installSplitAlignmentFixture,
  openSplitAlignment,
  expandSplitComment,
  scrollSplitAwayAndBack,
} from "./split-alignment-checks.ts";
import { chromium, expect } from "@playwright/test";
import { facts, workCardScenario, type FakeDaemon } from "@ace/fake-daemon";
import { mkdir, writeFile } from "node:fs/promises";
import {
  expectActiveTabVisible,
  expectDefaultDiffNoWrap,
  expectIdentifierIntact,
  expectIndependentSplitScroll,
  launchTool,
} from "./work-panel-checks.ts";

const base = "http://localhost:5184";
const out = "/tmp/ace-ui-571";
const files: string[] = [];
const errors: string[] = [];
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(
      (appearance) =>
        localStorage.setItem(
          "ace.appearance",
          JSON.stringify(
            appearance.includes("-")
              ? { theme: appearance.split("-")[0], mode: appearance.split("-")[1] }
              : { mode: appearance },
          ),
        ),
      theme,
    );
    const shot = async (name: string) => {
      const path = `${out}/${theme}-${name}.png`;
      await page.screenshot({ path, animations: "disabled" });
      files.push(path);
      console.log(path);
    };
    await page.goto(`${base}/t/thread-dedupe`);
    await page
      .getByRole("heading", { level: 1, name: "Dedupe thread events after reconnect" })
      .waitFor();
    await page.getByRole("button", { name: "Right panel", exact: true }).click();
    const work = page.getByRole("tabpanel", { name: "Work", exact: true });
    await work.getByRole("button", { name: "Branch fix/replay-dedupe, switch branch" }).waitFor();
    await expect(page.locator("header [data-work-card-toggle]")).toHaveCount(0);
    await expect(
      page.getByRole("banner").getByRole("button", { name: "Back", exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("banner").getByRole("button", { name: "Forward", exact: true }),
    ).toHaveCount(1);
    await expect(work.getByText(/The thread settles when|subagents are still running/)).toHaveCount(
      0,
    );
    await expect(page.getByRole("tab", { name: "Agents", exact: true })).toHaveCount(0);
    await expect(
      work.getByText(/Stack membership unavailable|missing or inaccessible/),
    ).toHaveCount(0);
    await expect(work.getByRole("button", { name: /^Pull request #214/ })).toHaveCount(1);
    await expect(work.getByText(/#214/)).toHaveCount(1);
    await expect(work.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Right panel", exact: true }).click();
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Open agent tree/ }).click();
    await expect(work.getByRole("tree", { name: "Agent tree" })).toBeVisible();
    await expectActiveTabVisible(page);
    await shot("01-work");
    await page.getByRole("tab", { name: "Changes", exact: true }).click();
    await page.getByRole("button", { name: "Diff options", exact: true }).waitFor();
    await expectDefaultDiffNoWrap(page);
    await expectIdentifierIntact(page, "lastCheckpointSeq");
    await expect(
      page
        .getByRole("tabpanel", { name: "Changes", exact: true })
        .getByRole("region", { name: "Review", exact: true }),
    ).toHaveCount(0);
    await shot("02-changes");
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    const tools = page.getByRole("list", { name: "Tools", exact: true });
    await tools.waitFor();
    await expect(page.getByRole("heading", { name: "Suggested", exact: true })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Address", exact: true })).toHaveCount(0);
    await shot("03-launcher");
    await tools.getByRole("button", { name: /^Browser(?: |$)/ }).click();
    await page.getByRole("combobox", { name: "Address", exact: true }).waitFor();
    await expect(page.getByRole("list", { name: "Tools", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Open a page", exact: true })).toHaveCount(0);
    await expect(page.getByText(/Type an address above|watch them or take over/)).toHaveCount(0);
    await shot("04-browser");
    for (const tool of ["Preview", "Devices", "Logs"]) await launchTool(page, tool);
    await expectActiveTabVisible(page);
    await page.getByRole("button", { name: "All tabs", exact: true }).click();
    await shot("05-overflow-menu");
    await page.getByRole("menuitem", { name: "Work", exact: true }).click();
    await expectActiveTabVisible(page);
    await page.setViewportSize({ width: 1120, height: 900 });
    await expectActiveTabVisible(page);
    await shot("06-active-tab-visible");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "All tabs", exact: true }).click();
    await page.getByRole("menuitem", { name: "Changes", exact: true }).click();
    await page.getByRole("button", { name: "Full view", exact: true }).click();
    await page.getByRole("button", { name: "Diff options", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Split", exact: true }).click();
    await expectIndependentSplitScroll(page);
    await expectIdentifierIntact(page, "lastCheckpointSeq");
    await shot("07-split-full-view");
    await page.getByRole("button", { name: "Diff options", exact: true }).click();
    await page
      .getByRole("menuitemcheckbox", { name: "Soft wrap at word boundaries", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await expectIdentifierIntact(page, "lastCheckpointSeq");
    await expectIdentifierIntact(page, "COLD_START_WINDOW");
    await shot("08-soft-wrap");
    await page
      .getByRole("button", { name: /^Comment on line [0-9]+$/ })
      .first()
      .click();
    await page
      .getByRole("textbox", { name: /^Comment on line/ })
      .fill("Check the reconnect boundary");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    const review = page.getByRole("region", { name: "Review", exact: true });
    await expect(review.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
    await expect(
      review.getByRole("button", { name: "Request changes", exact: true }),
    ).toBeVisible();
    await shot("11-review-with-comments");
    await page.getByRole("button", { name: "Exit full view", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Threads", exact: true })
      .getByRole("link", { name: /^Migrate settings schema/ })
      .click();
    await page
      .getByRole("heading", { level: 1, name: "Migrate settings schema", exact: true })
      .waitFor();
    const mod = await page.evaluate(() =>
      /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
    );
    await page.keyboard.press(`${mod}+[`);
    await page
      .getByRole("heading", { level: 1, name: "Dedupe thread events after reconnect", exact: true })
      .waitFor();
    await page.keyboard.press(`${mod}+]`);
    await page
      .getByRole("heading", { level: 1, name: "Migrate settings schema", exact: true })
      .waitFor();
    console.log(`${theme}: keyboard history and comment-triggered review controls verified`);
    await context.close();

    const fixture = workCardScenario("changes");
    const nested = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    const nestedPage = await nested.newPage();
    nestedPage.on("pageerror", (error) => errors.push(error.message));
    await nestedPage.addInitScript(
      ({ appearance, scenario, end }) => {
        localStorage.setItem(
          "ace.appearance",
          JSON.stringify(
            appearance.includes("-")
              ? { theme: appearance.split("-")[0], mode: appearance.split("-")[1] }
              : { mode: appearance },
          ),
        );
        Object.assign(globalThis, {
          aceFakeSetup: (daemon: FakeDaemon) => {
            daemon.createThread(scenario.thread);
            for (const step of scenario.steps)
              if (step.kind === "facts") daemon.apply(scenario.thread.id, step.facts);
            daemon.apply(scenario.thread.id, [end]);
            const snapshot = daemon.snapshot.bind(daemon);
            daemon.snapshot = (scope) => {
              const view = snapshot(scope);
              if (view?.kind !== "thread" || view.thread.id !== scenario.thread.id) return view;
              return {
                ...view,
                agents: Object.fromEntries(
                  Object.entries(view.agents).map(([id, agent]) => [
                    id,
                    agent.name === "Write retry tests"
                      ? { ...agent, status: { state: "idle" as const } }
                      : agent,
                  ]),
                ),
              };
            };
            daemon.refuseCommands(
              "private_server_detail_571",
              "forge.pr.status",
              "thread.interrupt",
              "background_task.stop",
            );
          },
        });
      },
      { appearance: theme, scenario: fixture, end: facts.endTurn("worker-0") },
    );
    await nestedPage.goto(`${base}/t/${fixture.thread.id}`);
    await nestedPage.getByRole("heading", { level: 1, name: fixture.thread.title }).waitFor();
    await nestedPage.getByRole("button", { name: "Right panel", exact: true }).click();
    const nestedWork = nestedPage.getByRole("tabpanel", { name: "Work", exact: true });
    await expect(
      nestedWork.getByRole("treeitem", {
        name: /^Write retry tests: Waiting on (work|subagents|background task)$/,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      nestedWork.getByRole("treeitem", { name: "Write retry tests: Idle", exact: true }),
    ).toHaveCount(0);
    await nestedWork.getByRole("button", { name: "Project actions", exact: true }).waitFor();
    const nestedPath = `${out}/${theme}-09-parent-waiting.png`;
    await nestedPage.screenshot({ path: nestedPath, animations: "disabled" });
    files.push(nestedPath);
    await nestedWork.getByRole("treeitem", { name: /^Write retry tests:/ }).click();
    const parentDetail = nestedPage.getByRole("tabpanel", {
      name: "Write retry tests",
      exact: true,
    });
    await expect(parentDetail.getByText("Waiting on work", { exact: true })).toBeVisible();
    await expect(parentDetail.getByText("Done", { exact: true })).toHaveCount(0);
    await expect(
      parentDetail.getByRole("button", {
        name: "Stop Write retry tests and its 1 subagent",
        exact: true,
      }),
    ).toBeVisible();
    const parentPath = `${out}/${theme}-16-parent-detail-active.png`;
    await nestedPage.screenshot({ path: parentPath, animations: "disabled" });
    files.push(parentPath);
    await parentDetail.getByRole("button", { name: /Back to agents/ }).click();
    await nestedWork.getByRole("treeitem", { name: /^Check supervisor logs:/ }).hover();
    await nestedWork
      .getByRole("button", { name: "Stop Check supervisor logs", exact: true })
      .click();
    await expect(nestedWork.getByRole("alert")).toHaveText("Couldn't stop this agent. Try again.");
    await nestedWork.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(nestedWork.getByText("Couldn't stop this command. Try again.")).toBeVisible();
    await expect(nestedWork.getByText("Couldn't stop this agent. Try again.")).toBeVisible();
    await expect(nestedWork.getByText(/private_server_detail_571/)).toHaveCount(0);
    const stopPath = `${out}/${theme}-13-stop-feedback.png`;
    await nestedPage.screenshot({ path: stopPath, animations: "disabled" });
    files.push(stopPath);
    await nestedPage.setViewportSize({ width: 390, height: 844 });
    await nestedPage.getByRole("button", { name: "Done", exact: true }).click();
    await nestedPage.getByRole("button", { name: "More actions", exact: true }).click();
    await nestedPage.getByRole("menuitem", { name: "Work", exact: true }).click();
    await expect(nestedWork).toBeVisible();
    await expect(
      nestedWork.getByRole("treeitem", {
        name: /^Write retry tests: Waiting on (work|subagents|background task)$/,
        exact: true,
      }),
    ).toBeVisible();
    const mobilePath = `${out}/${theme}-10-work-mobile.png`;
    await nestedPage.screenshot({ path: mobilePath, animations: "disabled" });
    files.push(mobilePath);
    await nestedWork.getByRole("button", { name: /^Pull request #188/ }).click();
    await expect(
      nestedWork.getByText("Couldn't read this pull request. Check the connection, then refresh."),
    ).toBeVisible();
    await expect(
      nestedWork.getByText(/private_server_detail_571|Stack membership unavailable/),
    ).toHaveCount(0);
    const errorPath = `${out}/${theme}-12-pr-unavailable.png`;
    await nestedPage.screenshot({ path: errorPath, animations: "disabled" });
    files.push(errorPath);
    await nested.close();
    const alignment = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    const alignedPage = await alignment.newPage();
    alignedPage.on("pageerror", (error) => errors.push(error.message));
    await alignedPage.addInitScript(
      (appearance) =>
        localStorage.setItem(
          "ace.appearance",
          JSON.stringify(
            appearance.includes("-")
              ? { theme: appearance.split("-")[0], mode: appearance.split("-")[1] }
              : { mode: appearance },
          ),
        ),
      theme,
    );
    await installSplitAlignmentFixture(alignedPage);
    await openSplitAlignment(alignedPage, base);
    const wrapPath = `${out}/${theme}-14-virtual-split-wrap.png`;
    await alignedPage.screenshot({ path: wrapPath, animations: "disabled" });
    files.push(wrapPath);
    await expandSplitComment(alignedPage);
    const commentPath = `${out}/${theme}-15-split-comment-aligned.png`;
    await alignedPage.screenshot({ path: commentPath, animations: "disabled" });
    files.push(commentPath);
    await scrollSplitAwayAndBack(alignedPage);
    console.log(
      `${theme}: split wrapping, comment growth and virtualized remount alignment verified`,
    );
    await alignment.close();
  }
  expect(errors).toEqual([]);
  await writeFile(
    `${out}/verification.json`,
    JSON.stringify({ files, pageErrors: errors }, null, 2),
  );
} finally {
  await browser.close();
}
