import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import type { DaemonTarget } from "@/boot/connection-settings.ts";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { DaemonForm } from "./daemon-form.tsx";

it("editing a paired connection retains the device identity in the submitted target", async () => {
  const target = {
    url: "wss://remote.example/",
    token: "a".repeat(64),
    pairedDeviceId: "read-only-device",
  };
  let submitted: DaemonTarget | undefined;
  render(
    <ToastProvider>
      <DaemonForm
        {...target}
        remembered={false}
        submitLabel="Connect"
        onSubmit={(next) => {
          submitted = next;
        }}
      />
    </ToastProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(submitted).toEqual(target));
});

it("a manually imported remote credential requires its paired device identity", async () => {
  let submitted: DaemonTarget | undefined;
  render(
    <ToastProvider>
      <DaemonForm
        url="wss://remote.example/"
        token={"a".repeat(64)}
        remembered={false}
        submitLabel="Connect"
        onSubmit={(next) => {
          submitted = next;
        }}
      />
    </ToastProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));
  const problem = await screen.findByRole("alert");
  expect(problem.textContent).toContain("Enter the device ID");
  expect(submitted).toBeUndefined();
  await userEvent.type(screen.getByLabelText("Paired device ID"), "imported-read-only-device");
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() =>
    expect(submitted).toEqual({
      url: "wss://remote.example/",
      token: "a".repeat(64),
      pairedDeviceId: "imported-read-only-device",
    }),
  );
});
