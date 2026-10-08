import {
  aceCall,
  aceToolsBrowser,
  aceToolsComputerUse,
  aceToolsDevices,
  facts,
  screenAudit,
} from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

/** Opens `threadId`'s finished turn and its work log; the open log's steps. */
async function openSteps(app: ReturnType<typeof harness>, threadId: string) {
  await app.open(`/t/${threadId}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await userEvent.click(await within(feed).findByRole("button", { name: /^Worked for/ }));
  return { feed, steps: await within(feed).findByRole("list", { name: "Steps" }) };
}

test("a refused background key press reads as a sentence naming Safari, with its icon, not raw codes", async () => {
  const app = harness();
  app.play(aceToolsComputerUse()).runThrough("used-safari");
  const { feed, steps } = await openSteps(app, "thread-ace-tools-safari");
  // The daemon's audits fold into the calls: no raw `key.press · com.apple.Safari` line anywhere.
  expect(feed.textContent).not.toMatch(/key\.press|com\.apple\.Safari|not_supported/);

  await userEvent.click(within(steps).getByRole("button", { name: /^Used Safari/ }));
  const safari = within(steps).getByRole("list", { name: "Used Safari" });
  const refused = within(safari).getByRole("button", {
    name: "Safari didn't accept that key in the background Failed",
  });
  // Safari's letter stands in for its icon in a browser (the desktop app shows the real one).
  expect(refused.textContent).toMatch(/^SSafari didn't accept/);
  expect(
    within(safari).getByRole("button", {
      name: "Safari's focus changed while typing; try again Failed",
    }),
  ).toBeTruthy();
  expect(
    within(safari).getByRole("button", { name: "Safari's window is off-screen Failed" }),
  ).toBeTruthy();
  // What it did, in words: the element's name comes from the window it read before.
  expect(within(safari).getByRole("button", { name: "Opened Safari" })).toBeTruthy();
  expect(within(safari).getByRole("button", { name: "Clicked “Sign in” in Safari" })).toBeTruthy();

  // The hint is one click away; the raw code only behind Details.
  await userEvent.click(refused);
  expect(within(safari).getByText(/Tried to press ⌘L in Safari\./)).toBeTruthy();
  expect(within(safari).queryByText(/not_supported/)).toBeNull();
  await userEvent.click(within(safari).getByRole("button", { name: "Details" }));
  expect(within(safari).getByText(/ace · screen_key · not_supported/)).toBeTruthy();
});

test("consecutive steps on one app collapse into one line that expands and collapses", async () => {
  const app = harness();
  app.play(aceToolsComputerUse()).runThrough("used-safari");
  const { steps } = await openSteps(app, "thread-ace-tools-safari");
  const group = within(steps).getByRole("button", {
    name: "Used Safari · 8 actions · 3 failed",
  });
  expect(group.getAttribute("aria-expanded")).toBe("false");
  expect(within(steps).queryByRole("button", { name: "Opened Safari" })).toBeNull();

  await userEvent.click(group);
  expect(group.getAttribute("aria-expanded")).toBe("true");
  const rows = within(within(steps).getByRole("list", { name: "Used Safari" })).getAllByRole(
    "listitem",
  );
  expect(rows).toHaveLength(8);

  await userEvent.click(group);
  expect(within(steps).queryByRole("list", { name: "Used Safari" })).toBeNull();
});

test("a screenshot a tool returned shows as a thumbnail that opens the lightbox", async () => {
  const app = harness();
  app.play(aceToolsBrowser()).runThrough("browsed");
  const { steps } = await openSteps(app, "thread-ace-tools-browser");
  await userEvent.click(within(steps).getByRole("button", { name: /^Browsed github\.com/ }));
  // The row reads what it did; under it, the picture it returned.
  expect(
    within(steps).getByRole("button", { name: "Took a screenshot of github.com", expanded: false }),
  ).toBeTruthy();
  const tile = await within(steps).findByRole("img", { name: "Took a screenshot of github.com" });
  expect(tile.getAttribute("src")).toMatch(/^data:image\/png;base64,/);

  await userEvent.click(tile.closest("button")!);
  const lightbox = await screen.findByRole("dialog", { name: "Took a screenshot of github.com" });
  expect(
    within(lightbox)
      .getByRole("img", { name: "Took a screenshot of github.com" })
      .getAttribute("src"),
  ).toMatch(/^data:image\/png;base64,/);
});

test("browser and device steps name the element and device from what earlier steps read", async () => {
  const browser = harness();
  browser.play(aceToolsBrowser()).runThrough("browsed");
  const { steps } = await openSteps(browser, "thread-ace-tools-browser");
  await userEvent.click(within(steps).getByRole("button", { name: /^Browsed github\.com/ }));
  expect(
    within(steps).getByRole("button", {
      name: "Typed “octocat” into “Username or email address”",
    }),
  ).toBeTruthy();
  expect(within(steps).getByRole("button", { name: "Clicked “Sign in”" })).toBeTruthy();
  expect(within(steps).getByRole("button", { name: "You have the browser Failed" })).toBeTruthy();
});

test("device steps read on the named simulator", async () => {
  const app = harness();
  app.play(aceToolsDevices()).runThrough("used-device");
  const { steps } = await openSteps(app, "thread-ace-tools-devices");
  await userEvent.click(within(steps).getByRole("button", { name: /^Used iPhone 16 Pro/ }));
  expect(
    within(steps).getByRole("button", { name: "Tapped “Log in” on iPhone 16 Pro" }),
  ).toBeTruthy();
  expect(
    within(steps).getByRole("button", {
      name: "The agent no longer controls iPhone 16 Pro Failed",
    }),
  ).toBeTruthy();
  expect(
    within(steps).getByRole("button", {
      name: "Delegated “Review the Shop sign-in screen for accessibility labels”",
    }),
  ).toBeTruthy();
});

test("an audit with no call, and a tool ace has no words for, still read plainly", async () => {
  const app = harness();
  app
    .play({
      thread: {
        id: "thread-ace-tools-odd",
        workspaceId: "ace",
        title: "Odd tools",
        provider: "codex",
      },
      steps: [
        {
          kind: "facts",
          label: "done",
          facts: [
            facts.rootAgent("codex"),
            facts.turn("root"),
            facts.message("root", "ask", "user", "Try things."),
            screenAudit(
              "root",
              "lone",
              "text.paste",
              "com.apple.TextEdit",
              "background",
              "clipboard_changed",
            ),
            aceCall("root", "new", "ace_frobnicate_widgets", { size: 3 }, [
              { type: "text", text: "{}" },
            ]),
            facts.message("root", "answer", "assistant", "Done."),
            facts.endTurn("root"),
          ],
        },
      ],
    })
    .runThrough("done");
  const { steps } = await openSteps(app, "thread-ace-tools-odd");
  expect(
    within(steps).getByRole("button", {
      name: "The clipboard changed while pasting into TextEdit Failed",
    }),
  ).toBeTruthy();
  expect(within(steps).getByRole("button", { name: "Used ace frobnicate widgets" })).toBeTruthy();
});
