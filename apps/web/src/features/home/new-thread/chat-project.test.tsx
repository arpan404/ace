import { act, configure, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

test("a chat the machine refuses says why, and a reconnect asks for it again", async () => {
  const app = harness();
  app.daemon.projects.refuseChats = "The chats folder can't be written.";
  await app.open("/new?project=chat");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The chats folder can't be written.");

  app.daemon.projects.refuseChats = undefined;
  act(() => app.daemon.disconnectAll());
  await waitFor(() =>
    expect(screen.queryByText(/Couldn't start a chat without a project/)).toBeNull(),
  );
  expect(await screen.findByRole("combobox", { name: "Message" })).toBeTruthy();
}, 30_000);
