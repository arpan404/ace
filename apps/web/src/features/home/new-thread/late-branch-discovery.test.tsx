import { workbench } from "@ace/fake-daemon";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("a preparation pins the base shown after late discovery even when the repository default changes", async () => {
  const made = harness();
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  const handle = made.daemon.services.handle.bind(made.daemon.services);
  let holding = true;
  let defaultBranch = "main";
  let deliver: (() => void) | undefined;
  made.daemon.services.handle = (message, push, device) => {
    if (message.type !== "workspace.request" || message.operation.op !== "branches.list")
      return handle(message, push, device);
    const reply = () =>
      push({
        type: "workspace.result",
        requestId: message.requestId,
        result: {
          kind: "branches",
          branches: ["main", "develop"],
          truncated: false,
          refs: [
            { name: "main" },
            { name: "main", remote: "origin" },
            { name: "develop" },
            { name: "develop", remote: "origin" },
          ],
          defaultBranch,
        },
      });
    if (holding) deliver = reply;
    else reply();
    return true;
  };
  await made.open("/new?project=relay");
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Pin the discovered base",
  );
  await screen.findByRole("link", { name: "Pin the discovered base. Draft, Project relay" });
  await act(async () => {
    if (!deliver) throw new Error("branch discovery was not requested");
    holding = false;
    deliver();
  });
  await screen.findByRole("button", { name: "Start from: origin/main" });
  cleanup();
  defaultBranch = "develop";
  await made.open("/new?project=relay");
  expect((await screen.findByRole("combobox", { name: "Message" })).textContent).toBe(
    "Pin the discovered base",
  );
  expect(await screen.findByRole("button", { name: "Start from: origin/main" })).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).not.toBe(
      "true",
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => {
    const view = made.daemon.snapshot({ kind: "threads" });
    const created =
      view?.kind === "threads" &&
      Object.values(view.threads).find((thread) => thread.title === "Pin the discovered base");
    expect(created && created.details?.base).toMatchObject({ ref: "main", remote: "origin" });
  });
});
