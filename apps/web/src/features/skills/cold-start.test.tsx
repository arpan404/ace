import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { CatalogEntry } from "@ace/protocol";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());
const tdd = CatalogEntry.parse({
  id: "claude-tdd",
  name: "tdd",
  title: "Test Driven Development",
  kind: "skill",
  description: "Write the failing test first.",
  source: { provider: "claude", scope: "global" },
  invocation: { type: "skill", name: "tdd", path: "/fixture/tdd/SKILL.md" },
});
function cold() {
  const app = harness({ throughWorker: true });
  app.daemon.createThread({
    id: "cold",
    workspaceId: "project",
    provider: "claude",
    title: "Cold start",
  });
  app.daemon.seedServices({
    settings: { "providers.default": "claude" },
    extensionCatalogs: { claude: [], pi: [] },
    catalogLoading: ["claude"],
  });
  return app;
}

test("Skills stays loading until discovery arrives in the open tab and opens the discovered skill", async () => {
  const app = cold();
  await app.open("/skills");
  expect(await screen.findAllByRole("status", { name: /Loading skills/ })).not.toHaveLength(0);
  expect(screen.queryByText("No skills yet")).toBeNull();
  act(() => app.daemon.seedServices({ extensionCatalogs: { claude: [tdd] } }));
  await userEvent.click(await screen.findByRole("link", { name: /^Test Driven Development/ }));
  expect(
    await screen.findByRole("heading", { level: 1, name: "Test Driven Development" }),
  ).toBeTruthy();
});

test("a cold slash menu reports loading and finds tdd when discovery completes without retyping", async () => {
  const app = cold();
  await app.open("/t/cold");
  const input = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.type(input, "/tdd");
  expect(await screen.findByText("Loading suggestions…")).toBeTruthy();
  expect(screen.queryByText("No matching suggestions")).toBeNull();
  act(() => app.daemon.seedServices({ extensionCatalogs: { claude: [tdd] } }));
  expect(await screen.findByRole("option", { name: /^Test Driven Development / })).toBeTruthy();
});

test("switching the Skills provider closes a detail from the previous provider", async () => {
  const app = cold();
  app.daemon.seedServices({ extensionCatalogs: { claude: [tdd], pi: [] } });
  await app.open("/skills");
  await userEvent.click(await screen.findByRole("link", { name: /^Test Driven Development/ }));
  await screen.findByRole("heading", { level: 1, name: "Test Driven Development" });
  await userEvent.click(screen.getByRole("combobox", { name: "Skills provider" }));
  await userEvent.click(await screen.findByRole("option", { name: /^Pi$/ }));
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "Test Driven Development" })).toBeNull(),
  );
  await waitFor(() => expect(screen.queryByText("This isn't installed")).toBeNull());
});

test("the composer discovers skills before the first slash so a warm tdd menu needs no new request", async () => {
  const app = cold();
  app.daemon.seedServices({ extensionCatalogs: { claude: [] } });
  await app.open("/t/cold");
  const input = await screen.findByRole("combobox", { name: "Message" });
  act(() => app.daemon.seedServices({ extensionCatalogs: { claude: [tdd] } }));
  app.daemon.holdRequests("catalog.list");
  await userEvent.type(input, "/tdd");
  expect(await screen.findByRole("option", { name: /^Test Driven Development / })).toBeTruthy();
});
