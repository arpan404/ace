import { Client } from "@ace/client";
import { ClientProvider } from "@ace/client-react";
import { DeviceId } from "@ace/protocol";
import { FakeDaemon, ScenarioPlayer, failingSubagent, fakeTransport } from "@ace/fake-daemon";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { memoryStorage } from "@/boot/client.ts";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { LayoutProvider } from "@/lib/layout.tsx";
import { useWorkspaceStore } from "@/lib/workspace/index.ts";
import { panelServices } from "../services.ts";
import ThreadBrowserBoundary from "./thread-browser.tsx";

// Load the daemon sources before behavioral deadlines begin.
await import("../panel-sources.ts");

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

function PanelSwitch(props: { threadId: string }) {
  const store = useWorkspaceStore();
  return (
    <>
      <button onClick={() => store.update(props.threadId, (state) => ({ ...state, open: true }))}>
        Open workspace
      </button>
      <button onClick={() => store.update(props.threadId, (state) => ({ ...state, open: false }))}>
        Close workspace
      </button>
    </>
  );
}

async function answer() {
  const question = await screen.findByRole("alertdialog");
  await userEvent.click(within(question).getByRole("button", { name: "OK" }));
}

async function setup() {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, failingSubagent()).step();
  const threadId = "thread-settings";
  daemon.browser.drive(threadId, { url: "http://localhost:5173" });
  let ids = 0;
  const client = new Client({
    deviceId: DeviceId.parse("test-device"),
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: memoryStorage(),
    random: () => 0.5,
    id: () => `id-${++ids}`,
    scheduler: {
      set(delay, work) {
        const timer = setTimeout(work, delay);
        return () => clearTimeout(timer);
      },
    },
  });
  clients.push(client);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const { preview } = await panelServices(client);
  const mounted = render(
    <ClientProvider client={client}>
      <LayoutProvider>
        <ToastProvider>
          <PanelSwitch threadId={threadId} />
          <ThreadBrowserBoundary threadId={threadId} />
        </ToastProvider>
      </LayoutProvider>
    </ClientProvider>,
  );
  await waitFor(() => expect(preview.view(threadId)?.controller).toBe("agent"));
  const ask = (type: "alert" | "confirm" | "prompt" = "confirm") =>
    act(() =>
      daemon.browser.dialogOpen(threadId, {
        dialogId: "question",
        tabId: daemon.browser.view(threadId)?.activeTabId ?? "",
        type,
        message: "Continue the form?",
      }),
    );
  return { daemon, client, preview, threadId, ask, answer, mounted };
}

test.each(["alert", "confirm", "prompt"] as const)(
  "answering a closed-panel %s returns control so the agent can navigate",
  async (type) => {
    const t = await setup();
    t.ask(type);
    await t.answer();
    await waitFor(() => expect(t.daemon.browser.view(t.threadId)?.pending_dialog).toBeUndefined());
    await waitFor(() => expect(t.daemon.browser.view(t.threadId)?.controller).toBe("agent"));
    await t.daemon.browser.navigateAgent(t.threadId, "http://localhost:5173/after-dialog");
    expect(t.daemon.browser.view(t.threadId)?.url).toBe("http://localhost:5173/after-dialog");
  },
);

test.each(["shared", "private"] as const)(
  "an existing %s hold survives a background dialog answer",
  async (mode) => {
    const t = await setup();
    await act(() => t.preview.takeover(t.threadId, mode));
    t.ask();
    await t.answer();
    await waitFor(() => expect(t.daemon.browser.view(t.threadId)?.pending_dialog).toBeUndefined());
    expect(t.daemon.browser.view(t.threadId)).toMatchObject({
      controller: "human",
      takeoverMode: mode,
    });
    await expect(
      t.daemon.browser.navigateAgent(t.threadId, "http://localhost:5173/agent"),
    ).rejects.toThrow("Browser controlled by human");
  },
);

test.each([
  ["takeover", "unmount"],
  ["answer", "unmount"],
  ["takeover", "open"],
  ["answer", "open"],
  ["takeover", "open then close"],
  ["answer", "open then close"],
] as const)("a delayed %s releases only its temporary hold after %s", async (phase, transition) => {
  const t = await setup();
  const started = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<void>();
  const request = t.client.request.bind(t.client);
  t.client.request = async (input, options) => {
    const result = await request(input, options);
    if (
      (phase === "takeover" && input.type === "browser.takeover") ||
      (phase === "answer" && input.type === "browser.execute" && input.command.action === "dialog")
    ) {
      started.resolve();
      await resumed.promise;
    }
    return result;
  };
  t.ask();
  await t.answer();
  await started.promise;
  if (transition === "unmount") t.mounted.unmount();
  else {
    await userEvent.click(screen.getByRole("button", { name: "Open workspace" }));
    if (transition === "open then close")
      await userEvent.click(screen.getByRole("button", { name: "Close workspace" }));
  }
  await act(async () => {
    resumed.resolve();
    await resumed.promise;
  });
  if (transition === "open") {
    await waitFor(() => expect(t.daemon.browser.view(t.threadId)?.pending_dialog).toBeUndefined());
    await t.client.request({ type: "browser.origins.list", threadId: t.threadId });
    expect(t.daemon.browser.view(t.threadId)?.controller).toBe("human");
    await userEvent.click(screen.getByRole("button", { name: "Close workspace" }));
  }
  await waitFor(() => expect(t.daemon.browser.view(t.threadId)?.controller).toBe("agent"));
  await t.daemon.browser.navigateAgent(t.threadId, "http://localhost:5173/continued");
  expect(t.daemon.browser.view(t.threadId)?.url).toBe("http://localhost:5173/continued");
});

test("a refused dialog answer releases its temporary control and leaves the question retryable", async () => {
  const t = await setup();
  const request = t.client.request.bind(t.client);
  let refused = true;
  t.client.request = async (input, options) => {
    if (refused && input.type === "browser.execute" && input.command.action === "dialog")
      throw new Error("Answer refused");
    return request(input, options);
  };
  t.ask();
  await t.answer();
  await screen.findByText("Couldn't answer the page");
  await waitFor(() => expect(t.daemon.browser.view(t.threadId)?.controller).toBe("agent"));
  expect(t.daemon.browser.view(t.threadId)?.pending_dialog?.dialogId).toBe("question");
  refused = false;
  const question = screen.getByRole("alertdialog", { name: "localhost:5173 asks" });
  await userEvent.click(within(question).getByRole("button", { name: "OK" }));
  await waitFor(() => expect(t.daemon.browser.view(t.threadId)?.pending_dialog).toBeUndefined());
  await waitFor(() => expect(t.daemon.browser.view(t.threadId)?.controller).toBe("agent"));
});

test("a failed temporary handback leaves a visible retry that restores agent control", async () => {
  const t = await setup();
  const request = t.client.request.bind(t.client);
  let refused = true;
  t.client.request = async (input, options) => {
    if (refused && input.type === "browser.handback") throw new Error("Handback refused");
    return request(input, options);
  };
  t.ask();
  await t.answer();
  await screen.findByText("Couldn't hand back the page");
  expect(t.daemon.browser.view(t.threadId)?.controller).toBe("human");
  refused = false;
  await userEvent.click(screen.getByRole("button", { name: "Hand back" }));
  await waitFor(() => expect(t.daemon.browser.view(t.threadId)?.controller).toBe("agent"));
});
