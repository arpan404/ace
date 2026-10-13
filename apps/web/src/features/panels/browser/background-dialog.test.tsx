import { Client } from "@ace/client";
import { ClientProvider } from "@ace/client-react";
import { DeviceId } from "@ace/protocol";
import { FakeDaemon, ScenarioPlayer, failingSubagent, fakeTransport } from "@ace/fake-daemon";
import { useState } from "react";
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
await import("@/components/ui/toast-view.tsx");

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

function ThreadSwitch(props: { threadId: string }) {
  const [shown, setShown] = useState(true);
  return (
    <>
      <button onClick={() => setShown(false)}>Leave thread</button>
      {shown && <ThreadBrowserBoundary threadId={props.threadId} />}
    </>
  );
}

async function answer() {
  const question = await screen.findByRole("alertdialog");
  await userEvent.click(within(question).getByRole("button", { name: "OK" }));
}

/** An error toast, read from the notification stack rather than its screen-reader echo. */
async function notice(text: string) {
  const notifications = await screen.findByRole("region", { name: "Notifications" });
  return within(notifications).findByText(text);
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
          <ThreadSwitch threadId={threadId} />
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
      (phase === "answer" && input.type === "browser.dialog.answer")
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
  await act(async () => {
    await t.client.request({ type: "browser.origins.list", threadId: t.threadId });
  });
  expect(screen.queryAllByText("Couldn't hand back the page")).toHaveLength(0);
  await t.daemon.browser.navigateAgent(t.threadId, "http://localhost:5173/continued");
  expect(t.daemon.browser.view(t.threadId)?.url).toBe("http://localhost:5173/continued");
});

test("a refused dialog answer releases its temporary control and leaves the question retryable", async () => {
  const t = await setup();
  const request = t.client.request.bind(t.client);
  let refused = true;
  t.client.request = async (input, options) => {
    if (refused && input.type === "browser.dialog.answer")
      throw new Error("Answer refused");
    return request(input, options);
  };
  t.ask();
  await t.answer();
  await notice("Couldn't answer the page");
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
  await notice("Couldn't hand back the page");
  expect(t.daemon.browser.view(t.threadId)?.controller).toBe("human");
  refused = false;
  await userEvent.click(screen.getByRole("button", { name: "Hand back" }));
  await waitFor(() => expect(t.daemon.browser.view(t.threadId)?.controller).toBe("agent"));
});

test.each(["stay", "leave"])(
  "an applied takeover with a failed reply returns temporary control after %s",
  async (transition) => {
    const t = await setup();
    const started = Promise.withResolvers<void>();
    const failed = Promise.withResolvers<void>();
    const request = t.client.request.bind(t.client);
    t.client.request = async (input, options) => {
      const result = await request(input, options);
      if (input.type === "browser.takeover") {
        started.resolve();
        await failed.promise;
        throw new Error("Request timed out after takeover applied");
      }
      return result;
    };
    t.ask();
    await t.answer();
    await started.promise;
    expect(t.daemon.browser.view(t.threadId)?.controller).toBe("human");
    if (transition === "leave")
      await userEvent.click(screen.getByRole("button", { name: "Leave thread" }));
    await act(async () => failed.resolve());
    await notice("Couldn't answer the page");
    await waitFor(() => expect(t.daemon.browser.view(t.threadId)?.controller).toBe("agent"));
    expect(screen.queryAllByText("Couldn't hand back the page")).toHaveLength(0);
    await t.daemon.browser.navigateAgent(t.threadId, "http://localhost:5173/after-timeout");
    expect(t.daemon.browser.view(t.threadId)?.url).toBe("http://localhost:5173/after-timeout");
  },
);

test("an ambiguous takeover that cannot be released after leaving exposes a working recovery action", async () => {
  const t = await setup();
  const started = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<void>();
  const request = t.client.request.bind(t.client);
  let refuseHandback = true;
  t.client.request = async (input, options) => {
    if (input.type === "browser.handback" && refuseHandback)
      throw new Error("Handback unavailable");
    const result = await request(input, options);
    if (input.type === "browser.takeover") {
      started.resolve();
      await failed.promise;
      throw new Error("Takeover reply timed out");
    }
    return result;
  };
  t.ask();
  await t.answer();
  await started.promise;
  await userEvent.click(screen.getByRole("button", { name: "Leave thread" }));
  await act(async () => failed.resolve());
  await notice("Couldn't hand back the page");
  expect(t.daemon.browser.view(t.threadId)?.controller).toBe("human");
  refuseHandback = false;
  await userEvent.click(screen.getByRole("button", { name: "Hand back" }));
  await waitFor(() => expect(t.daemon.browser.view(t.threadId)?.controller).toBe("agent"));
  await t.daemon.browser.navigateAgent(t.threadId, "http://localhost:5173/recovered");
  expect(t.daemon.browser.view(t.threadId)?.url).toBe("http://localhost:5173/recovered");
});

test("a refused takeover preserves another device's shared control without a false handback error", async () => {
  const t = await setup();
  await act(() => t.daemon.browser.takeover(t.threadId, "other-device", "shared"));
  t.ask();
  await t.answer();
  await notice("Couldn't answer the page");
  await act(async () => {
    await t.client.request({ type: "browser.origins.list", threadId: t.threadId });
  });
  expect(t.daemon.browser.view(t.threadId)).toMatchObject({
    controller: "human",
    owner: "other-device",
  });
  expect(screen.queryAllByText("Couldn't hand back the page")).toHaveLength(0);
});

test("a late dialog completion preserves a newer deliberate shared hold", async () => {
  const t = await setup();
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const request = t.client.request.bind(t.client);
  t.client.request = async (input, options) => {
    const result = await request(input, options);
    if (input.type === "browser.dialog.answer") {
      started.resolve();
      await resume.promise;
    }
    return result;
  };
  t.ask();
  await t.answer();
  await started.promise;
  await act(async () => {
    await t.preview.handback(t.threadId);
    await t.preview.takeover(t.threadId, "shared");
    resume.resolve();
  });
  await act(async () => {
    await t.client.request({ type: "browser.origins.list", threadId: t.threadId });
  });
  expect(t.daemon.browser.view(t.threadId)?.controller).toBe("human");
  expect(t.preview.heldAs(t.threadId)).toBe(t.daemon.browser.view(t.threadId)?.owner);
  expect(screen.queryAllByText("Couldn't hand back the page")).toHaveLength(0);
  await expect(
    t.daemon.browser.navigateAgent(t.threadId, "http://localhost:5173/blocked"),
  ).rejects.toThrow("Browser controlled by human");
});
