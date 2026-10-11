import { ClientProvider } from "@ace/client-react";
import { FakeDaemon } from "@ace/fake-daemon";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { fakeClient } from "@/test/fake-client.ts";
import { ConnectionNotice } from "./connection-notice.tsx";

// Code delivery is the boundary: fail the optional chunk as an offline browser would.
vi.mock("./offline-notice.tsx", () => {
  throw new Error("Failed to fetch offline detail chunk");
});

test("an unavailable offline detail chunk preserves the draft and transcript and reconnects", async () => {
  const client = fakeClient(new FakeDaemon({ clock: () => 1000 }));
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
  // The failed optional region has its own code recovery action.
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("Offline");
  act(() => client.networkOnline(true));
  await waitFor(() => expect(screen.queryByText("Offline")).toBeNull());
  expect(screen.getByLabelText("Draft")).toHaveProperty("value", "Keep this draft");
});
