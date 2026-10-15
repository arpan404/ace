import { workbench } from "@ace/fake-daemon";
import type { ClientMessage } from "@ace/protocol";
import { act, cleanup, configure, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

function preparing(matches: (message: ClientMessage) => boolean) {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const service = app.daemon.service.bind(app.daemon);
  const replies: (() => void)[] = [];
  let holding = true;
  app.daemon.service = (message, connection) => {
    if (holding && matches(message)) {
      replies.push(() => connection.receive(JSON.stringify(message)));
      return true;
    }
    return service(message, connection);
  };
  return {
    ...app,
    async release() {
      await act(async () => {
        holding = false;
        for (const reply of replies.splice(0)) reply();
      });
    },
    created() {
      const view = app.daemon.snapshot({ kind: "threads" });
      return view?.kind === "threads"
        ? Object.values(view.threads).filter((thread) => thread.title === "Send after preparation")
        : [];
    },
  };
}

const capabilities = (message: ClientMessage) => message.type === "permissions.capabilities";

test.each(["models", "branches", "storage"])(
  "one Enter sends once after delayed %s resolves",
  async (gate) => {
    const app = preparing((message) =>
      gate === "models"
        ? message.type === "models.list"
        : gate === "branches"
          ? message.type === "workspace.request" && message.operation.op === "branches.list"
          : message.type === "context.request" && message.operation.op === "draft.create",
    );
    await app.open("/new?project=relay");
    const prompt = await screen.findByRole("combobox", { name: "Message" });
    await userEvent.type(prompt, "Send after preparation{Enter}{Enter}");
    expect(screen.getByRole("button", { name: "Cancel send" })).toBeTruthy();
    expect(prompt.textContent).toBe("Send after preparation");
    expect(app.created()).toHaveLength(0);
    await app.release();
    await screen.findByRole("heading", { level: 1, name: "Send after preparation" });
    await waitFor(() => expect(app.created()).toHaveLength(1));
    if (gate === "branches")
      expect(app.created()[0]?.details?.base).toEqual({ ref: "main", remote: "origin" });
  },
);

test.each(["cancel", "edit", "navigate", "access"])(
  "%s cancels a pending send and keeps the draft unsent when preparation finishes",
  async (action) => {
    const app = preparing(
      action === "access"
        ? (message) =>
            message.type === "workspace.request" && message.operation.op === "branches.list"
        : capabilities,
    );
    const view = await app.open("/new?project=relay");
    const prompt = await screen.findByRole("combobox", { name: "Message" });
    await userEvent.type(prompt, "Send after preparation");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Cancel send" });
    if (action === "cancel")
      await userEvent.click(screen.getByRole("button", { name: "Cancel send" }));
    if (action === "edit") await userEvent.type(prompt, " with changes");
    if (action === "navigate") view.unmount();
    if (action === "access") {
      await userEvent.click(screen.getByRole("button", { name: /^Access:/ }));
      await userEvent.click(await screen.findByRole("menuitemradio", { name: /Read.only/ }));
    }
    await app.release();
    if (action !== "navigate") {
      await waitFor(() => expect(screen.queryByText("Checking provider settings…")).toBeNull());
      expect(prompt.textContent).toContain("Send after preparation");
    }
    expect(app.created()).toHaveLength(0);
  },
);

test("a failed readiness check cancels the send and explains why the draft is retained", async () => {
  const app = preparing(capabilities);
  await app.open("/new?project=relay");
  const prompt = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.type(prompt, "Send after preparation{Enter}");
  // The daemon changes from pending to a real refusal at the request boundary.
  app.daemon.services.installed.clear();
  await app.release();
  await screen.findByText("Couldn't check provider access. Reconnect and try again.");
  expect(prompt.textContent).toBe("Send after preparation");
  expect(app.created()).toHaveLength(0);
});

test("a preparation timeout keeps the message and does not send when late reads finish", async () => {
  const app = preparing(capabilities);
  await app.open("/new?project=relay");
  const prompt = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.type(prompt, "Send after preparation");
  const schedule = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, ms, ...args) => {
    if (ms === 30_000)
      expire = () => {
        callback(...args);
      };
    return schedule(callback, ms, ...args);
  });
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await act(async () => {
    if (!expire) throw new Error("Preparation did not set its deadline");
    expire();
  });
  expect(screen.getByRole("alert").textContent).toContain("Preparation is taking too long");
  expect(prompt.textContent).toBe("Send after preparation");
  await app.release();
  await waitFor(() => expect(screen.queryByText("Checking provider settings…")).toBeNull());
  expect(app.created()).toHaveLength(0);
});
