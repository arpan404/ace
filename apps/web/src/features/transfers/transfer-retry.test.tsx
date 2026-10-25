import { configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { linkedMachines, optionsFor, strip } from "./transfer-fixture.tsx";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const failure = { code: "transfer_corrupt", message: "The copy on Build server didn't match." };

/** Continue on the build server without ignored files, fail it, and close the chooser. */
async function failedWithoutIgnored() {
  const fixture = linkedMachines();
  const { app, finish } = fixture;
  app.daemon.transfers.failWith = failure;
  await app.open("/t/thread-forecast");
  const dialog = await optionsFor("Build server");
  await userEvent.click(within(dialog).getByRole("switch", { name: "Bring ignored files" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue on Build server" }));
  await finish();
  expect(await within(dialog).findByText(failure.message)).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(await strip(failure.message)).toBeTruthy();
  app.daemon.transfers.failWith = undefined;
  return fixture;
}

test("the strip's Try again repeats the choices the transfer was made with", async () => {
  const { app, finish } = await failedWithoutIgnored();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await finish();
  expect(await strip("Continued on Build server")).toBeTruthy();
  const [again] = app.daemon.transfers.list();
  expect(again?.options).toEqual({ includeChanges: true, includeIgnored: false });
  expect(again?.ignoredFiles).toBeUndefined();
}, 30_000);

test("Try again says why the machine refused it", async () => {
  const { app, build } = await failedWithoutIgnored();
  app.daemon.linkTo(build, { status: "offline" });
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(
    await strip("Build server is offline or unreachable. Wake it and start ace there."),
  ).toBeTruthy();
  expect(app.daemon.transfers.list()).toHaveLength(1);
}, 30_000);

test("Try again on a transfer that doesn't say its choices asks for them again", async () => {
  const { app, finish } = linkedMachines();
  app.daemon.transfers.failWith = failure;
  app.daemon.transfers.echoOptions = false;
  await app.open("/t/thread-forecast");
  const dialog = await optionsFor("Build server");
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue on Build server" }));
  await finish();
  await userEvent.keyboard("{Escape}");
  expect(await strip(failure.message)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  const again = await screen.findByRole("dialog", { name: "Continue on another machine" });
  expect(within(again).getByRole("switch", { name: "Bring uncommitted changes" })).toBeTruthy();
  expect(within(again).getByRole("button", { name: "Continue on Build server" })).toBeTruthy();
  expect(app.daemon.transfers.list()).toHaveLength(1);
}, 30_000);

test("a refusal shows the daemon's own words", async () => {
  const { app, build } = linkedMachines();
  await app.open("/t/thread-forecast");
  const dialog = await optionsFor("Build server");
  // It went offline after the list was read.
  app.daemon.linkTo(build, { status: "offline" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue on Build server" }));
  expect(
    await within(dialog).findByText(
      "Build server is offline or unreachable. Wake it and start ace there.",
    ),
  ).toBeTruthy();
}, 30_000);

test.each([
  [
    "machine_not_linked",
    "This machine isn't linked to Build server. Link them in Settings › Fleet.",
  ],
  ["workspace_preparing", "The thread's checkout is still being made. Try again once it's ready."],
  ["thread_not_found", "That thread isn't on this machine any more."],
])(
  "a refusal without words says what %s means",
  async (code, words) => {
    const { app } = linkedMachines();
    app.daemon.refuseCommands(code, "thread.continueOn");
    await app.open("/t/thread-forecast");
    const dialog = await optionsFor("Build server");
    await userEvent.click(within(dialog).getByRole("button", { name: "Continue on Build server" }));
    expect(await within(dialog).findByText(words)).toBeTruthy();
  },
  30_000,
);

test("a dismissed failure stays dismissed when the thread opens again", async () => {
  const { app } = await failedWithoutIgnored();
  app.daemon.createThread({
    id: "thread-other",
    workspaceId: "weather",
    title: "Tidy the README",
    provider: "claude",
    hasSentMessage: true,
  });
  await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByText(failure.message)).toBeNull();
  // Away to another thread, and back through the thread's row.
  const threads = await screen.findByRole("list", { name: "Threads" });
  await userEvent.click(await within(threads).findByRole("link", { name: /^Tidy the README/ }));
  await screen.findByRole("heading", { level: 1, name: "Tidy the README" });
  await userEvent.click(
    await within(threads).findByRole("link", { name: /^Fix the forecast cache/ }),
  );
  await screen.findByRole("heading", { name: "Fix the forecast cache" });
  await screen.findByRole("button", { name: "More actions" });
  expect(screen.queryByText(failure.message)).toBeNull();
}, 30_000);

test("Cancel can't be pressed twice while it runs, and says why it couldn't cancel", async () => {
  const { app, step } = linkedMachines();
  await app.open("/t/thread-forecast");
  const dialog = await optionsFor("Build server");
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue on Build server" }));
  await step();
  app.daemon.holdRequests("transfers.request");
  await userEvent.click(await within(dialog).findByRole("button", { name: "Cancel" }));
  expect(within(dialog).getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(
    true,
  );
  // The connection drops before the daemon answers.
  app.daemon.disconnectAll();
  expect(
    await within(dialog).findByText("This machine isn't connected. Try again once it is."),
  ).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(
    false,
  );
}, 30_000);

test("a failure that came without words says what its code means", async () => {
  const { app, finish } = linkedMachines();
  app.daemon.transfers.failWith = { code: "changes_conflict", message: "" };
  await app.open("/t/thread-forecast");
  const dialog = await optionsFor("Build server");
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue on Build server" }));
  await finish();
  expect(
    await within(dialog).findByText("The uncommitted changes don't apply cleanly on Build server."),
  ).toBeTruthy();
}, 30_000);

test("cancelling a transfer that already arrived is refused as too late", async () => {
  const { app, finish } = linkedMachines();
  await app.open("/t/thread-forecast");
  const dialog = await optionsFor("Build server");
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue on Build server" }));
  await finish();
  expect(await within(dialog).findByText("Continued on Build server")).toBeTruthy();
  const [done] = app.daemon.transfers.list();
  await expect(app.client.transfers.cancel(done?.transferId ?? "")).rejects.toMatchObject({
    code: "too_late",
    message: "It already reached Build server; the work is there now.",
  });
  expect(app.daemon.transfers.list()[0]?.phase).toBe("completed");
}, 30_000);
