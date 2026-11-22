import { fakeAskApp, type FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, openProfile, spadeApp, withEndpoint } from "@/test/spade.ts";

/*
 * A connected app's requests (ADR 0202, amendment 5): the calls one app makes together answer on
 * one card, and "Always allow for Notion" grants that bot the app's writes, with the person's
 * stamp, then allows them. The bot's Permissions › Apps row shows it and takes it back.
 */

beforeEach(() => configure({ asyncUtilTimeout: 3_000 }));

const pages = (n: number) =>
  Array.from({ length: n }, (_, at) => ({
    callId: `k${at + 1}`,
    name: "notion__create_page",
    args: { title: `Page ${at + 1}` },
    reason:
      "It may change something in the app, and the bot has read untrusted content, so you decide.",
  }));

function seed(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  const quill = spade.addAgent({ id: "quill", name: "Quill", state: "idle" });
  spade.connectors.connectors.push({
    id: "notion",
    name: "Notion",
    url: "https://mcp.notion.com/mcp",
    catalogue: "notion",
    sign_in: "oauth",
    state: "connected",
    account: "sam@acme.dev",
    tools: 12,
  });
  spade.connectors.access.set("quill", { all: false, connectors: ["notion"] });
  return quill;
}

async function quillsCard() {
  await userEvent.click(await botRow("Quill"));
  return within(
    await screen.findByRole("group", { name: "Quill wants to make 3 changes in Notion" }),
  );
}

const answered = (spade: FakeSpadeApi) =>
  ["k1", "k2", "k3"].map(
    (call) => spade.sent("POST", `/v1/conversations/c-quill/approvals/${call}`)[0],
  );

test("three requests one app made together are one card, and Allow all answers each", async () => {
  const { spade } = await spadeApp("/spade", (api) =>
    fakeAskApp(api, seed(api), "notion", pages(3)),
  );
  const card = await quillsCard();
  expect(screen.queryAllByRole("group", { name: /^Quill wants to/ })).toHaveLength(1);
  expect(within(card.getByRole("list", { name: "Calls" })).getAllByRole("listitem")).toHaveLength(
    3,
  );
  expect(card.getByText(/may change something in the app/)).toBeTruthy();
  await userEvent.click(card.getByRole("button", { name: /^Allow all/ }));
  await waitFor(() => expect(answered(spade).every(Boolean)).toBe(true));
  for (const body of answered(spade)) expect(body).toMatchObject({ allowed: true });
  expect(spade.security.bot("quill").grants).toHaveLength(0);
});

test("Always allow for Notion grants this bot the app's writes, then allows them; the Apps row takes it back", async () => {
  const { spade } = await spadeApp("/spade", (api) =>
    fakeAskApp(api, seed(api), "notion", pages(3)),
  );
  const card = await quillsCard();
  await userEvent.click(card.getByRole("button", { name: "Always allow for Notion" }));
  await waitFor(() => expect(answered(spade).every(Boolean)).toBe(true));
  // Each tool on the card, pinned to the definition the person was shown.
  expect(spade.sent("POST", "/v1/agents/quill/grants")).toEqual([
    {
      kind: "app",
      app: "notion",
      writes: true,
      tools: { notion__create_page: "def-notion__create_page" },
    },
  ]);
  expect(spade.sent("POST", "/v1/agents/main/grants")).toHaveLength(0);
  for (const body of answered(spade)) expect(body).toMatchObject({ allowed: true });

  await openProfile("Quill");
  const profile = within(await screen.findByRole("region", { name: "Quill's profile" }));
  await userEvent.click(profile.getByRole("tab", { name: "Permissions" }));
  expect(await profile.findByText("Its changes run without asking")).toBeTruthy();
  await userEvent.click(
    profile.getByRole("button", { name: "Ask again before Quill changes things in Notion" }),
  );
  await waitFor(() => expect(spade.security.bot("quill").grants).toHaveLength(0));
});

test("without the person's standing, Always allow asks them to confirm it's them and allows nothing yet", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    fakeAskApp(api, seed(api), "notion", pages(3));
    api.security.permissions.standing = false;
  });
  const card = await quillsCard();
  await userEvent.click(card.getByRole("button", { name: "Always allow for Notion" }));
  await waitFor(() =>
    expect(card.getByText(/confirm it's you/i, { selector: "[role=status]" })).toBeTruthy(),
  );
  expect(spade.security.bot("quill").grants).toHaveLength(0);
  expect(answered(spade).some(Boolean)).toBe(false);
});

test("one app request reads as what it does and offers Always allow for its app", async () => {
  const { spade } = await spadeApp("/spade", (api) =>
    fakeAskApp(api, seed(api), "notion", pages(1)),
  );
  await userEvent.click(await botRow("Quill"));
  const card = within(
    await screen.findByRole("group", { name: "Quill wants to create a Notion page" }),
  );
  await userEvent.click(card.getByRole("button", { name: "Always allow for Notion" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/conversations/c-quill/approvals/k1")).toHaveLength(1),
  );
  expect(spade.sent("POST", "/v1/agents/quill/grants")).toHaveLength(1);
});

/** A send the gate read as one, to nested recipients. */
const send = (callId: string, to: unknown) => ({
  callId,
  name: "notion__notify_people",
  args: { message: { body: "Trip notes", to } },
  effect: "send_as_person",
  ask: null,
  reason: "It sends something in your name, so you decide.",
});

test("each call shows where it goes, nested recipients included, with its full arguments a tap away", async () => {
  await spadeApp("/spade", (api) =>
    fakeAskApp(api, seed(api), "notion", [
      ...pages(2),
      send("k8", [{ name: "Ana", email: "ana@x.test" }, "sam@x.test"]),
      send("k9", { email: "lee@x.test" }),
    ]),
  );
  await userEvent.click(await botRow("Quill"));
  // Sends are never folded into the changes' card: they get their own, headed by the gate.
  const changes = within(
    await screen.findByRole("group", { name: "Quill wants to make 2 changes in Notion" }),
  );
  expect(changes.getByText("Create a Notion page · Page 1")).toBeTruthy();
  const sends = within(
    await screen.findByRole("group", {
      name: "Quill wants to send 2 things in your name with Notion",
    }),
  );
  expect(sends.queryByRole("button", { name: "Always allow for Notion" })).toBeNull();
  expect(sends.getByText(/ana@x\.test, sam@x\.test/)).toBeTruthy();
  expect(sends.getByText(/lee@x\.test/)).toBeTruthy();
  // Nothing is allowed before the person can open everything a call sends.
  await userEvent.click(sends.getAllByRole("button", { name: /^Details of / })[0] as HTMLElement);
  const shown = sends.getByLabelText(/^Arguments of /).textContent ?? "";
  expect(shown).toContain('"email": "ana@x.test"');
  expect(shown).toContain('"body": "Trip notes"');
});

test("a call whose name looks like a read but the gate couldn't place never reads as one", async () => {
  await spadeApp("/spade", (api) =>
    fakeAskApp(api, seed(api), "notion", [
      { callId: "k1", name: "notion__list_and_delete", args: {}, ask: null },
      { callId: "k2", name: "notion__list_and_delete", args: {}, ask: null },
    ]),
  );
  await userEvent.click(await botRow("Quill"));
  const card = within(
    await screen.findByRole("group", {
      name: "Quill wants to use Notion 2 times, in ways it doesn't declare",
    }),
  );
  expect(card.getAllByText("Use Notion to list and delete")).toHaveLength(2);
  expect(card.queryByRole("button", { name: "Always allow for Notion" })).toBeNull();
});
