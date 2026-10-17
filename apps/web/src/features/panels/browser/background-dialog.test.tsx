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
import { panelServices } from "../services.ts";
import ThreadBrowserBoundary from "./thread-browser.tsx";

// Load the daemon sources before behavioral deadlines begin.
await import("../panel-sources.ts");
await import("@/components/ui/toast-view.tsx");

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

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
  render(
    <ClientProvider client={client}>
      <LayoutProvider>
        <ToastProvider>
          <ThreadBrowserBoundary threadId={threadId} />
        </ToastProvider>
      </LayoutProvider>
    </ClientProvider>,
  );
  await waitFor(() => expect(preview.view(threadId)?.closed).toBe(false));
  const ask = (type: "alert" | "confirm" | "prompt" = "confirm") =>
    act(() =>
      daemon.browser.dialogOpen(threadId, {
        dialogId: "question",
        tabId: daemon.browser.view(threadId)?.activeTabId ?? "",
        type,
        message: "Continue the form?",
      }),
    );
  return { daemon, client, preview, threadId, ask, answer };
}

test.each(["alert", "confirm", "prompt"] as const)(
  "answering a closed-panel %s clears it while the agent keeps working",
  async (type) => {
    const t = await setup();
    t.ask(type);
    await t.answer();
    await waitFor(() => expect(t.daemon.browser.view(t.threadId)?.pending_dialog).toBeUndefined());
    await t.daemon.browser.navigateAgent(t.threadId, "http://localhost:5173/after-dialog");
    expect(t.daemon.browser.view(t.threadId)?.url).toBe("http://localhost:5173/after-dialog");
  },
);

test("an answer sends nothing but the answer: no control changes hands on the way", async () => {
  const t = await setup();
  const sent: string[] = [];
  const request = t.client.request.bind(t.client);
  t.client.request = async (input, options) => {
    sent.push(input.type);
    return request(input, options);
  };
  t.ask();
  await t.answer();
  await waitFor(() => expect(t.daemon.browser.view(t.threadId)?.pending_dialog).toBeUndefined());
  expect(
    sent.filter((type) => type.startsWith("browser.") && type !== "browser.subscribe"),
  ).toEqual(["browser.dialog.answer"]);
});

test("a refused dialog answer leaves the question retryable", async () => {
  const t = await setup();
  const request = t.client.request.bind(t.client);
  let refused = true;
  t.client.request = async (input, options) => {
    if (refused && input.type === "browser.dialog.answer") throw new Error("Answer refused");
    return request(input, options);
  };
  t.ask();
  await t.answer();
  await notice("Couldn't answer the page");
  expect(t.daemon.browser.view(t.threadId)?.pending_dialog?.dialogId).toBe("question");
  refused = false;
  const question = screen.getByRole("alertdialog", { name: "localhost:5173 asks" });
  await userEvent.click(within(question).getByRole("button", { name: "OK" }));
  await waitFor(() => expect(t.daemon.browser.view(t.threadId)?.pending_dialog).toBeUndefined());
});
