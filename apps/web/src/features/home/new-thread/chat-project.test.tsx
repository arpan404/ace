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

test("a device that may start threads but not manage projects still starts a chat there", async () => {
  const app = harness({
    machines: [{ hostId: "studio", name: "Studio", scopes: ["read", "operate"] }],
  });
  await app.open("/new?project=chat&machine=studio");
  expect(await screen.findByRole("combobox", { name: "Message" })).toBeTruthy();
  expect(screen.queryByText(/Couldn't start a chat without a project/)).toBeNull();
}, 30_000);

test("a chat refused for lack of access says so in words, never as its code", async () => {
  const app = harness({ machines: [{ hostId: "studio", name: "Studio", scopes: ["read"] }] });
  await app.open("/new?project=chat&machine=studio");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("This device isn't allowed to do that.");
  expect(alert.textContent).not.toMatch(/\bforbidden\b/);
}, 30_000);
