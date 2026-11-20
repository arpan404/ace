import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, openProfile, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/** The Running page's rows, top to bottom. */
async function runningRows() {
  const list = await screen.findByRole("list", { name: "Running" });
  return within(list)
    .getAllByRole("listitem")
    .filter((item) => item.parentElement === list);
}

test("Running lists every bot in Spade's order with its state in words, and Pause, Resume and Stop act on it", async () => {
  const { spade } = await spadeApp("/spade/running", (seed) => {
    withEndpoint(seed);
    seed.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    seed.addAgent({ id: "fares", name: "Fares", state: "working", status: "Checking fares" });
    seed.addAgent({ id: "mail", name: "Mail", state: "waiting", waiting_for: "question" });
    seed.running.pause(seed.addAgent({ id: "post", name: "Post" }));
    seed.running.facts.set("fares", {
      spend: { today_micros: 420_000, month_micros: 3_100_000 },
      network: { sent_bytes: 200, received_bytes: 1_000, hosts: ["api.fares.dev"] },
      workers: [{ id: "slow", name: "Slow", state: "working", doing: "Reading a page" }],
    });
  });

  // Needs you, then working, then paused, then idle; Spade's own bot is an ordinary row.
  await waitFor(async () => expect(await runningRows()).toHaveLength(4));
  const rows = await runningRows();
  expect(rows.map((row) => row.querySelector("p")?.textContent)).toEqual([
    "Mail",
    "Fares",
    "Post",
    "Spade",
  ]);
  const [mail, fares, post] = rows.map((row) => within(row));
  expect(mail?.getByText("Waiting on you: a question")).toBeTruthy();
  expect(fares?.getByText("Checking fares")).toBeTruthy();
  expect(fares?.getByText(/\$0\.42 today · \$3\.10 this month/)).toBeTruthy();
  expect(fares?.getByText(/1\.2 kB with api\.fares\.dev/)).toBeTruthy();
  // Its worker, under it, in words.
  expect(
    within(fares?.getByRole("list", { name: "Fares's workers" }) ?? document.body).getByText(
      /Reading a page/,
    ),
  ).toBeTruthy();
  expect(post?.getByText("Paused")).toBeTruthy();
  expect(post?.queryByRole("button", { name: "Pause Post" })).toBeNull();

  // Pause holds Fares; its row says so at once, and it offers Resume instead.
  await userEvent.click(fares?.getByRole("button", { name: "Pause Fares" }) ?? document.body);
  const paused = within(
    (await screen.findByRole("button", { name: "Resume Fares" })).closest("li") ?? document.body,
  );
  expect(paused.getByText("Paused")).toBeTruthy();
  await userEvent.click(paused.getByRole("button", { name: "Resume Fares" }));
  await screen.findByRole("button", { name: "Pause Fares" });

  // Stop ends its work and its workers.
  await userEvent.click(await screen.findByRole("button", { name: "Stop Fares" }));
  await waitFor(() => expect(screen.queryByRole("list", { name: "Fares's workers" })).toBeNull());
  expect(spade.running.actions).toEqual([
    { agent: "fares", action: "pause" },
    { agent: "fares", action: "resume" },
    { agent: "fares", action: "stop" },
  ]);

  // Open goes to the bot's conversation.
  await userEvent.click(await screen.findByRole("link", { name: "Open Mail" }));
  expect(await screen.findByRole("feed", { name: "Conversation with Mail" })).toBeTruthy();
});

test("Spade's own profile opens Running; another bot's doesn't offer it", async () => {
  await spadeApp("/spade", (seed) => {
    withEndpoint(seed);
    seed.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    seed.addAgent({ id: "scout", name: "Scout" });
  });
  await userEvent.click(await botRow("Scout"));
  await openProfile("Scout");
  await screen.findByRole("heading", { name: "Task" });
  expect(screen.queryByRole("heading", { name: "Running" })).toBeNull();

  await userEvent.click(await botRow("Spade"));
  await openProfile("Spade");
  const heading = await screen.findByRole("heading", { name: "Running" });
  await userEvent.click(
    within(heading.closest("section") ?? document.body).getByRole("link", { name: "Open" }),
  );
  expect(await screen.findByRole("list", { name: "Running" })).toBeTruthy();
});

test("an archived bot says so on Running and in its profile, and Unarchive from either brings it back", async () => {
  const { spade } = await spadeApp("/spade/running", (seed) => {
    withEndpoint(seed);
    seed.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    seed.addAgent({ id: "poster", name: "Poster", archived: true });
    seed.addAgent({ id: "digest", name: "Digest", archived: true });
  });
  await waitFor(async () => expect(await runningRows()).toHaveLength(3));
  const poster = within(
    (await screen.findByRole("button", { name: "Unarchive Poster" })).closest("li") ??
      document.body,
  );
  expect(poster.getByText(/Archived/)).toBeTruthy();
  await userEvent.click(poster.getByRole("button", { name: "Unarchive Poster" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Unarchive Poster" })).toBeNull(),
  );
  expect(spade.running.actions).toEqual([{ agent: "poster", action: "unarchive" }]);

  // From the profile: its line says it is archived, and Unarchive takes the line away.
  await userEvent.click(await botRow("Digest"));
  await openProfile("Digest");
  const line = within(await screen.findByRole("note", { name: "Digest is archived" }));
  await userEvent.click(line.getByRole("button", { name: "Unarchive" }));
  await waitFor(() =>
    expect(screen.queryByRole("note", { name: "Digest is archived" })).toBeNull(),
  );
  expect(spade.running.actions.at(-1)).toEqual({ agent: "digest", action: "unarchive" });
  expect(spade.agents.find((agent) => agent.id === "digest")?.archived).toBe(false);
});
