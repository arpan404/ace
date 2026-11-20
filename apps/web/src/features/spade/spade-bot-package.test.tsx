import type { FakeSpadeApi } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/*
 * A bot linked to an agent package (ADR 0200 §3.9) says in its profile which package and version
 * it came from, offers Update when the Marketplace has a newer one and Roll back to the version
 * it had before, each opening its review; a withdrawn version reads as paused, with the reason;
 * an update accepted while it works says it waits for the turn; and its Security section has
 * each declared effect as a switch with its reason (ADR 0200 §3.4). A development bot (ADR 0200
 * §9) says so in one quiet word wherever it is named.
 */

const linked = (link: Record<string, unknown>) => (spade: FakeSpadeApi) => {
  withEndpoint(spade);
  spade.addAgent({
    id: "fares",
    name: "Flight watcher",
    package: { source: "market", name: "flight-watcher", hash: "h", effects: [], ...link },
  });
};

test("a linked bot's profile names its package and version, with Update and Roll back", async () => {
  const history = createMemoryHistory({ initialEntries: ["/spade/fares?profile=details"] });
  await spadeApp(
    "/spade/fares?profile=details",
    linked({ version: "2.0.0", previous: { version: "1.0.0" } }),
    {
      history,
      daemon: (daemon) =>
        daemon.seedServices({
          marketplace: {
            installed: [
              {
                source: "market",
                type: "spade-bot",
                name: "flight-watcher",
                title: "Flight watcher",
                version: "2.0.0",
                hash: "a".repeat(64),
                acceptedAt: 1,
                state: "on",
                target: "fares",
                linked: true,
                update: "2.1.0",
              },
            ],
          },
        }),
    },
  );
  expect(await screen.findByText("From flight-watcher 2.0.0 in the Marketplace.")).toBeTruthy();
  expect(await screen.findByRole("button", { name: "Update to 2.1.0" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Roll back to 1.0.0" }));
  await waitFor(() =>
    expect(new URLSearchParams(history.location.search).get("market")).toBe(
      "bot/flight-watcher/rollback/fares",
    ),
  );
});

test("a bot whose version was withdrawn reads as paused, with the reason", async () => {
  await spadeApp(
    "/spade/fares?profile=details",
    linked({ version: "1.0.0", withdrawn: { reason: "It sent too many requests." } }),
  );
  expect(
    await screen.findByText(
      "Paused: flight-watcher 1.0.0 was withdrawn. It sent too many requests.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Update to/ })).toBeNull();
});

test("an update accepted while the bot works says it waits for the bot's turn", async () => {
  await spadeApp(
    "/spade/fares?profile=details",
    linked({ version: "1.0.0", held: { version: "2.0.0" } }),
  );
  expect(
    await screen.findByText(
      "From flight-watcher 1.0.0 in the Marketplace. Updates when Flight watcher is done with its turn.",
    ),
  ).toBeTruthy();
});

const declared = [
  {
    key: "network:hosts:api.example-fares.com",
    effect: "network",
    hosts: ["api.example-fares.com"],
    why: "Reads fares.",
    on: true,
  },
  { key: "publish", effect: "publish", hosts: [], why: "Posts a weekly fare report.", on: false },
  {
    key: "send_as_person",
    effect: "send_as_person",
    hosts: [],
    why: "Drafts a mail to your travel agent.",
    on: false,
  },
];

async function securitySection() {
  const section = (await screen.findByRole("heading", { name: "Security" })).closest("section");
  if (!section) throw new Error("no Security section");
  return within(section);
}

test("a packaged bot's Security section has each declared effect as a switch with its reason", async () => {
  const { spade } = await spadeApp(
    "/spade/fares?profile=details",
    linked({ version: "1.0.0", effects: declared }),
  );
  const security = await securitySection();
  const reach = await security.findByRole("switch", { name: "Reaches api.example-fares.com" });
  expect(reach.getAttribute("aria-checked")).toBe("true");
  expect(security.getByText("Reads fares.")).toBeTruthy();
  expect(
    security.getByText("Drafts a mail to your travel agent. You decide each time."),
  ).toBeTruthy();
  const publish = security.getByRole("switch", { name: "Publishes and posts" });
  expect(publish.getAttribute("aria-checked")).toBe("false");

  // Turning one on is the person's grant: Spade records it, and the row reads it back.
  await userEvent.click(publish);
  await waitFor(() =>
    expect(
      security.getByRole("switch", { name: "Publishes and posts" }).getAttribute("aria-checked"),
    ).toBe("true"),
  );
  const stored = spade.agents.find((agent) => agent.id === "fares")?.package as {
    effects: { key: string; on: boolean }[];
  };
  expect(stored.effects.find((effect) => effect.key === "publish")?.on).toBe(true);
  // Only what the package declared is there to turn on.
  expect(security.queryByRole("switch", { name: /Can ask you to pay/ })).toBeNull();
});

test("a bot from an ace template is offered the newer template its Spade ships, reviewed before it moves", async () => {
  const offered = { source: "spade", name: "inbox", version: "1.0.0", hash: "b".repeat(64) };
  const { spade } = await spadeApp("/spade/inbox?profile=details", (fake) => {
    withEndpoint(fake);
    fake.addAgent({
      id: "inbox",
      name: "My inbox",
      package: {
        source: "spade",
        name: "inbox",
        version: "0.9.0",
        hash: "a".repeat(64),
        previous: { version: "0.8.0" },
        template_update: { version: "1.0.0" },
        effects: [{ key: "network", effect: "network", hosts: [], why: "Sorts mail.", on: true }],
      },
      templateOffer: {
        package: offered,
        plan: {
          name: "kept",
          task: "replace",
          face: "same",
          personality: "same",
          routines: [],
          notes_kept: 0,
          asks_more: ["send_as_person"],
          off: [],
        },
        effects: [
          { key: "network", effect: "network", hosts: [], why: "Sorts mail.", on: true },
          { key: "send_as_person", effect: "send_as_person", hosts: [], why: "Sends.", on: false },
        ],
      },
    });
  });
  expect(await screen.findByText("From ace's inbox template 0.9.0.")).toBeTruthy();
  // Its earlier versions aren't kept anywhere, so there is nothing to roll back to.
  expect(screen.queryByRole("button", { name: /^Roll back/ })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Update to 1.0.0" }));

  const review = within(await screen.findByRole("dialog"));
  expect(
    within(await review.findByRole("list", { name: "What changes" })).getByText(
      "Its task changes to the new one.",
    ),
  ).toBeTruthy();
  expect(
    within(review.getByRole("list", { name: "Stays because you changed it" })).getByText(
      "You renamed it, so it keeps its name.",
    ),
  ).toBeTruthy();
  expect(
    within(review.getByRole("list", { name: "Asks for more" })).getByText(
      "Can ask you to send things in your name. Off until you turn it on.",
    ),
  ).toBeTruthy();
  // Nothing moved while the person read it.
  const stored = () => spade.agents.find((agent) => agent.id === "inbox")?.package;
  expect(stored()?.["version"]).toBe("0.9.0");

  await userEvent.click(review.getByRole("button", { name: "Update to 1.0.0" }));
  expect(await screen.findByText("From ace's inbox template 1.0.0.")).toBeTruthy();
  expect(stored()?.["hash"]).toBe(offered.hash);
  expect(screen.queryByRole("button", { name: /^Update to/ })).toBeNull();
});

test("a development bot says Development in its row, its profile and on Running, and is never updated through the Marketplace", async () => {
  const history = createMemoryHistory({ initialEntries: ["/spade/fares?profile=details"] });
  await spadeApp(
    "/spade/fares?profile=details",
    (spade) => {
      withEndpoint(spade);
      spade.addAgent({
        id: "fares",
        name: "Flight watcher",
        package: {
          source: "local",
          name: "local/flight-watcher",
          version: "local",
          previous: { version: "local" },
          hash: "h",
          effects: [],
        },
      });
      spade.addAgent({
        id: "inbox",
        name: "Inbox",
        package: { source: "market", name: "inbox", version: "1.0.0", hash: "i", effects: [] },
      });
    },
    { history },
  );
  const row = within(await botRow("Flight watcher"));
  expect(row.getByText("Development")).toBeTruthy();
  expect(within(await botRow("Inbox")).queryByText("Development")).toBeNull();

  const head = (await screen.findByRole("button", { name: "Rename Flight watcher" })).parentElement;
  expect(within(head ?? document.body).getByText("Development")).toBeTruthy();
  expect(
    await screen.findByText("Updated from its package folder on this machine with ace bot dev."),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Roll back/ })).toBeNull();

  history.push("/spade/running");
  const running = await screen.findByRole("list", { name: "Running" });
  const item = async (name: string) =>
    within(
      (await within(running).findByRole("link", { name: `Open ${name}` })).closest("li") ??
        document.body,
    );
  expect((await item("Flight watcher")).getByText("Development")).toBeTruthy();
  expect((await item("Inbox")).queryByText("Development")).toBeNull();
});
