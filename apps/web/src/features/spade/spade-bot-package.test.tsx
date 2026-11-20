import type { FakeSpadeApi } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { configure, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/*
 * A bot linked to an agent package (ADR 0200 §3.9) says in its profile which package and version
 * it came from, offers Update when the Marketplace has a newer one and Roll back to the version
 * it had before, each opening its review; a withdrawn version reads as paused, with the reason.
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
      "bot/flight-watcher/rollback",
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
