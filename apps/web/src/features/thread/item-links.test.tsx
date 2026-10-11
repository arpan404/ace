import { facts } from "@ace/fake-daemon";
import { ThreadId, ThreadView } from "@ace/protocol";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { harness } from "@/test/harness.tsx";

it("item links reveal old history and a second link changes the target within the same thread", async () => {
  const history = createMemoryHistory({ initialEntries: ["/new"] });
  const app = harness({ snapshotItems: 2, history });
  app.daemon.createThread({ id: "linked", workspaceId: "ace", title: "Linked", provider: "codex" });
  app.daemon.apply("linked", [
    facts.rootAgent("codex"),
    facts.message("root", "first", "assistant", "First old finding"),
    ...Array.from({ length: 220 }, (_, index) =>
      facts.message("root", `gap-${index}`, "assistant", `Context ${index}`),
    ),
    facts.message("root", "second", "assistant", "Second old finding"),
    facts.message("root", "third", "assistant", "Recent finding"),
    facts.message("root", "fourth", "assistant", "Latest finding"),
  ]);
  const old = app.daemon
    .replay({ kind: "thread", threadId: ThreadId.parse("linked") }, 0)
    .flatMap((event) => (event.payload.type === "item.created" ? [event.payload.item.id] : []));
  const first = old[0];
  const second = old[221];
  if (!first || !second) throw new Error("Missing message facts");
  await app.open("/new");
  await act(async () => history.push(`/t/linked?item=${encodeURIComponent(first)}`));
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  expect(await within(feed).findByText("First old finding")).toBeTruthy();
  await act(async () => history.push(`/t/linked?item=${encodeURIComponent(second)}`));
  expect(await within(feed).findByText("Second old finding")).toBeTruthy();
  await waitFor(() => expect(within(feed).queryByText("First old finding")).toBeNull());
  await act(async () => history.push("/t/linked?item=unknown"));
  const fallback = await screen.findByRole("alert");
  expect(fallback.textContent).toContain("That item is no longer available");
  expect(await within(feed).findByText("Latest finding")).toBeTruthy();
});

it("notification targets select current pending requests with working keyboard navigation", async () => {
  const history = createMemoryHistory({ initialEntries: ["/t/requests"] });
  const app = harness({ history });
  app.daemon.createThread({
    id: "requests",
    workspaceId: "ace",
    title: "Requests",
    provider: "codex",
  });
  app.daemon.apply("requests", [
    facts.rootAgent("codex"),
    ...["First approval", "Second approval"].map((title, index) => ({
      type: "interaction.opened" as const,
      agent: "root",
      interaction: `request-${index}`,
      blocking: true,
      request: {
        kind: "approval" as const,
        title,
        options: [{ id: "allow", label: "Allow once", kind: "allow_once" as const }],
      },
    })),
  ]);
  const view = ThreadView.parse(
    app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("requests") }),
  );
  const target = Object.values(view.interactions).find(
    (interaction) =>
      interaction.request.kind === "approval" && interaction.request.title === "Second approval",
  );
  if (!target) throw new Error("Missing canonical approval");
  await app.open("/t/requests");
  const region = await screen.findByRole("region", { name: "Waiting for you" });
  expect(await within(region).findByRole("article", { name: "First approval" })).toBeTruthy();
  await act(async () => history.push(`/t/requests?item=${encodeURIComponent(target.id)}`));
  expect(await within(region).findByRole("article", { name: "Second approval" })).toBeTruthy();
  await waitFor(() => expect(region.parentElement?.contains(document.activeElement)).toBe(true));
  await userEvent.keyboard("]");
  expect(await within(region).findByRole("article", { name: "First approval" })).toBeTruthy();
  await userEvent.keyboard("[[");
  expect(await within(region).findByRole("article", { name: "Second approval" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("combobox"));
  await act(async () => history.push("/t/requests?item=stale-interaction"));
  const fallback = await screen.findByRole("alert");
  expect(fallback.textContent).toContain("That item is no longer available");
  expect(within(region).queryByRole("article", { name: "stale-interaction" })).toBeNull();
});
