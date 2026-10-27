import { workbench } from "@ace/fake-daemon";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { writeDraft } from "@/features/thread/index.ts";
import { preparationKey, savePreparation } from "./preparations.ts";

test("a chat draft reopens, discards and undoes without exposing its hidden project", async () => {
  const made = harness();
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  await made.open("/new?project=chat");
  await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), "Chat draft");
  const row = await screen.findByRole("link", { name: /Chat draft\. Draft/ });
  expect(new URL(row.getAttribute("href") ?? "", "http://ace").searchParams.get("project")).toBe(
    "chat",
  );
  await userEvent.click(screen.getByRole("button", { name: "Project: none" }));
  await userEvent.click(await screen.findByRole("option", { name: "relay" }));
  await userEvent.click(await screen.findByRole("link", { name: /Chat draft\. Draft/ }));
  expect((await screen.findByRole("combobox", { name: "Message" })).textContent).toBe("Chat draft");
  await userEvent.click(screen.getByRole("button", { name: /^Discard draft in/ }));
  await waitFor(() => expect(screen.queryByRole("list", { name: "Draft threads" })).toBeNull());
  expect((await screen.findByRole("combobox", { name: "Message" })).textContent).toBe("");
  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe("Chat draft"),
  );
  expect(screen.queryByText("Add your first project")).toBeNull();
});

test("an existing chat draft with a hidden project id reopens after that project expires", async () => {
  const storage = memoryKeyValue();
  const made = harness({ storage });
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  await made.open("/new?project=relay");
  await screen.findByRole("combobox", { name: "Message" });
  const host = (await made.client.request({ type: "host.identity" })).identity.hostId;
  cleanup();
  const key = preparationKey(host, "chat");
  savePreparation(storage, host, key, {
    project: "expired-chat-project",
    choices: { project: "expired-chat-project" },
    title: "Saved chat",
  });
  writeDraft(storage, key, { text: "Saved chat", mentions: [], attachments: [] });
  await made.open("/");
  await userEvent.click(await screen.findByRole("link", { name: /Saved chat\. Draft/ }));
  expect((await screen.findByRole("combobox", { name: "Message" })).textContent).toBe("Saved chat");
  expect(screen.queryByRole("heading", { name: "Project unavailable" })).toBeNull();
});
