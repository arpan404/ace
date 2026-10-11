import { ClientProvider } from "@ace/client-react";
import { FakeDaemon, ScenarioPlayer, failingSubagent } from "@ace/fake-daemon";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThreadId } from "@ace/protocol";
import { expect, test, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { fakeClient } from "@/test/fake-client.ts";
import { ConnectionNotice } from "./connection-notice.tsx";

// Code delivery is the boundary: fail the optional chunk as an offline browser would.
vi.mock("./offline-notice.tsx", () => {
  throw new Error("Failed to fetch offline detail chunk");
});

test("an unavailable offline detail chunk retries successfully without losing the draft, transcript or waiting actions", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, failingSubagent()).step();
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  render(
    <ClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <ConnectionNotice />
          <p>Cached answer</p>
          <textarea aria-label="Draft" defaultValue="Keep this draft" />
        </ToastProvider>
      </TooltipProvider>
    </ClientProvider>,
  );
  act(() => client.networkOnline(false));
  await screen.findByText("Couldn't show offline actions");
  expect(screen.getByLabelText("Draft")).toHaveProperty("value", "Keep this draft");
  expect(screen.getByText("Cached answer")).toBeTruthy();
  expect(screen.getByText("Offline")).toBeTruthy();
  let queued: ReturnType<typeof client.command> | undefined;
  act(() => {
    queued = client.command({
      type: "thread.send",
      threadId: ThreadId.parse("thread-settings"),
      input: [{ type: "text", text: "Retry this task" }],
    });
  });
  // Code delivery becomes available again. The same mounted notice must retry its rejected load.
  vi.doUnmock("./offline-notice.tsx");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  fireEvent.click(await screen.findByRole("button", { name: "Offline · 1 waiting" }));
  expect(await screen.findByText("Message · Retry this task")).toBeTruthy();
  expect(screen.getByLabelText("Draft")).toHaveProperty("value", "Keep this draft");
  expect(screen.getByText("Cached answer")).toBeTruthy();
  act(() => client.networkOnline(true));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Offline · 1 waiting" })).toBeNull(),
  );
  expect((await queued)?.ok).toBe(true);
  expect(screen.getByLabelText("Draft")).toHaveProperty("value", "Keep this draft");
});
