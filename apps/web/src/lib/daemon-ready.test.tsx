import { FakeDaemon } from "@ace/fake-daemon";
import { ClientProvider } from "@ace/client-react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { Button } from "@/components/ui/button.tsx";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { fakeClient } from "@/test/harness.tsx";
import { useDaemonReady } from "./daemon-command.ts";

function Refresh(props: { onRefresh(): void }) {
  const daemon = useDaemonReady();
  return (
    <Button {...daemon.props} title={daemon.reason} onClick={daemon.guard(props.onRefresh)}>
      Refresh
    </Button>
  );
}

test("a request-backed control says why it can't work while the daemon is away, and doesn't fire", async () => {
  const daemon = new FakeDaemon({ clock: () => 1 });
  const client = fakeClient(daemon);
  await client.start();
  const fired: string[] = [];
  render(
    <ClientProvider client={client}>
      <ToastProvider>
        <Refresh onRefresh={() => fired.push("refresh")} />
      </ToastProvider>
    </ClientProvider>,
  );
  const button = screen.getByRole("button", { name: "Refresh" });
  await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
  await userEvent.click(button);
  expect(fired).toEqual(["refresh"]);

  act(() => daemon.refuseConnections(true));
  expect(await screen.findByTitle("Reconnect to the daemon to do this")).toBe(button);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  await userEvent.click(button);
  expect(fired).toEqual(["refresh"]);
  expect(await screen.findByText("Reconnect to the daemon to do this")).toBeTruthy();
});
