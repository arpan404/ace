import { facts, type Scenario } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { answerStore } from "./interactions/answers.ts";
import { harness } from "@/test/harness.tsx";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
});
afterEach(() => {
  answerStore.forgetAll();
  vi.unstubAllGlobals();
});

function request(command: string): Scenario {
  return {
    thread: { id: "thread-risk", workspaceId: "relay", provider: "codex", title: "Review cleanup" },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("codex"),
          facts.turn("root"),
          facts.tool("root", "shell", {
            kind: "shell",
            title: command,
            detail: { kind: "shell", command },
          }),
          {
            type: "interaction.opened",
            agent: "root",
            interaction: "risk",
            item: "shell",
            blocking: true,
            request: {
              kind: "approval",
              title: "Run cleanup",
              options: [
                { id: "allow", kind: "allow_once", label: "Allow once" },
                { id: "always", kind: "allow_session", label: "Allow for session" },
                { id: "deny", kind: "deny", label: "Deny" },
              ],
            },
          },
        ],
      },
      { kind: "await", interaction: "risk" },
    ],
  };
}

for (const command of ["rm -rf ./cache", "git push --force origin main"])
  test(`${command} opens on Deny, cannot be approved by number keys, and allows a deliberate click`, async () => {
    const app = harness({
      matchMedia: (query) => ({
        matches: query.includes("min-width"),
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }),
    });
    app.play(request(command)).runUntilBlocked();
    await app.open("/t/thread-risk");
    const card = await screen.findByRole("article", { name: "Run cleanup" });
    const deny = within(card).getByRole("button", { name: "Deny" });
    await waitFor(() => expect(document.activeElement).toBe(deny));
    await userEvent.keyboard("12");
    expect(app.daemon.isPending("thread-risk", "risk")).toBe(true);
    expect(await within(card).findByText(/Read the request/)).toBeTruthy();
    await userEvent.click(within(card).getByRole("button", { name: "Allow once" }));
    await waitFor(() =>
      expect(app.daemon.resolution("thread-risk", "risk")).toEqual({
        kind: "approval",
        optionId: "allow",
      }),
    );
  });

test("Activity reads risk from the actual linked shell step and blocks A", async () => {
  const app = harness({
    matchMedia: (query) => ({
      matches: query.includes("min-width"),
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }),
  });
  app.play(request("rm -rf ./cache")).runUntilBlocked();
  await app.open("/activity");
  const card = await screen.findByRole("article", { name: "Run cleanup" });
  await waitFor(() => expect(card.getAttribute("aria-current")).toBe("true"));
  await userEvent.click(within(card).getByRole("button", { name: /^Expand request:/ }));
  await userEvent.keyboard("a");
  expect(await within(card).findByText(/Read the request/)).toBeTruthy();
  expect(app.daemon.isPending("thread-risk", "risk")).toBe(true);
  await userEvent.keyboard("d");
  await waitFor(() =>
    expect(app.daemon.resolution("thread-risk", "risk")).toEqual({
      kind: "approval",
      optionId: "deny",
    }),
  );
});
