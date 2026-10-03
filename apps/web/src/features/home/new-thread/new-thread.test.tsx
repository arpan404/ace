import { workbench } from "@ace/fake-daemon";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

function app(options: Parameters<typeof harness>[0] = {}) {
  const made = harness(options);
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  return made;
}
const listed = (made: ReturnType<typeof harness>) => {
  const view = made.daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? Object.values(view.threads) : [];
};
const prompt = () => screen.findByRole("textbox", { name: "What should the agent do?" });

test("⌘N, a project, a model and a message start a thread that then opens", async () => {
  const made = app();
  await made.open("/");
  await screen.findByRole("navigation", { name: "Threads" });
  await userEvent.keyboard("{Meta>}n{/Meta}");
  await screen.findByRole("heading", { level: 1, name: "New thread" });

  await userEvent.click(await screen.findByRole("button", { name: /^Project:/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "relay" }));
  await userEvent.click(await screen.findByRole("button", { name: /^Model: Opus 4.6/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "GPT-5.3 Codex" }));
  expect(
    await screen.findByRole("button", { name: "Model: GPT-5.3 Codex, account work" }),
  ).toBeTruthy();

  const field = await prompt();
  expect((screen.getByRole("button", { name: "Start thread" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await userEvent.type(field, "Log every restart with its backoff delay{Enter}");

  // The daemon created it from the request, and the app opened it.
  await screen.findByRole("heading", {
    level: 1,
    name: "Log every restart with its backoff delay",
  });
  const created = listed(made).find((t) => t.title === "Log every restart with its backoff delay");
  expect(created).toMatchObject({ workspaceId: "relay", provider: "codex" });
  const nav = screen.getByRole("navigation", { name: "Threads" });
  expect(within(nav).getByRole("link", { name: /Log every restart/ })).toBeTruthy();
});

test("Shift+Enter writes a new line instead of sending", async () => {
  const made = app();
  await made.open("/new");
  const field = await prompt();
  await userEvent.type(field, "First line{Shift>}{Enter}{/Shift}second line");
  expect((field as HTMLTextAreaElement).value).toBe("First line\nsecond line");
  expect(listed(made)).toHaveLength(workbench().length);
});

test("the last model, account and work mode are remembered for the next thread", async () => {
  const storage = memoryKeyValue();
  await app({ storage }).open("/new?project=ace");
  await userEvent.click(await screen.findByRole("button", { name: /^Model:/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Account work" }));
  await userEvent.click(screen.getByRole("button", { name: "Where the work happens: Worktree" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Local" }));
  // A worktree's base branch only applies to worktrees.
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /^Start from branch/ })).toBeNull(),
  );
  cleanup();

  await app({ storage }).open("/new");
  expect(await screen.findByRole("button", { name: "Model: Opus 4.6, account work" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Where the work happens: Local" })).toBeTruthy();
});
