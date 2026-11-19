import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, waitFor } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { botRow, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const spadeHere = (spade: FakeSpadeApi, createdAt = 1) => {
  withEndpoint(spade);
  spade.addAgent({
    id: "main",
    kind: "main",
    name: "Spade",
    avatar: { kind: "spade" },
    created_at: createdAt,
  });
};

test("a bot whose Spade stops while its machine stays online reads as unavailable, not working", async () => {
  const { app, others } = await spadeApp("/spade", spadeHere, {
    machines: [
      {
        hostId: "studio",
        name: "Studio Mac",
        seed: (spade) => {
          const research = spade.addAgent({ id: "research", name: "Research" });
          spade.status(research, "working", "Reading a page");
        },
      },
    ],
  });
  await waitFor(async () =>
    expect((await botRow("Research")).textContent).toContain("Reading a page"),
  );
  const studio = app.machines.get("studio");
  if (!studio || !others.get("studio")) throw new Error("no studio");
  studio.spade.status = { state: "off" };
  await waitFor(async () =>
    expect((await botRow("Research")).textContent).toContain("Off on Studio Mac"),
  );
  expect((await botRow("Research")).querySelector("svg.bot-face")?.getAttribute("data-state")).toBe(
    "idle",
  );
});

const chosen = (host: string, version = 1) => ({ host, version, at: 5, by: "person" });

test("no window switches a Spade off: two showing Spade get one first choice, the oldest", async () => {
  const { spade, others } = await spadeApp("/spade", (api) => spadeHere(api, 9), {
    machines: [{ hostId: "studio", name: "Studio Mac", seed: (api) => spadeHere(api, 3) }],
  });
  const studio = others.get("studio");
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/main/host")).toEqual([
      expect.objectContaining({ host: "studio", version: 1, by: "seed" }),
    ]),
  );
  await waitFor(() =>
    expect(studio?.sent("PUT", "/v1/main/host")).toEqual([
      expect.objectContaining({ host: "studio", version: 1, by: "seed" }),
    ]),
  );
  await waitFor(async () =>
    expect((await botRow("Spade")).getAttribute("href")).toContain("on=studio"),
  );
  expect(spade.sent("PUT", "/v1/main")).toEqual([]);
  expect(studio?.sent("PUT", "/v1/main")).toEqual([]);
});

test("the main Spade stays on the chosen machine when that machine goes offline and comes back", async () => {
  const { app, spade, others } = await spadeApp(
    "/spade",
    (api) => {
      spadeHere(api, 1);
      api.hostRecord = chosen("studio");
    },
    {
      machines: [
        {
          hostId: "studio",
          name: "Studio Mac",
          seed: (api) => {
            spadeHere(api, 5);
            api.hostRecord = chosen("studio");
            api.addAgent({ id: "research", name: "Research" });
          },
        },
      ],
    },
  );
  await waitFor(async () =>
    expect((await botRow("Spade")).getAttribute("href")).toContain("on=studio"),
  );
  app.crashMachine("studio");
  await waitFor(async () =>
    expect((await botRow("Research")).textContent).toContain("Studio Mac is offline"),
  );
  expect((await botRow("Spade")).getAttribute("href")).toContain("on=studio");
  app.pool().reconnect("studio");
  await waitFor(async () =>
    expect((await botRow("Research")).textContent).not.toContain("offline"),
  );
  expect((await botRow("Spade")).getAttribute("href")).toContain("on=studio");
  expect(spade.sent("PUT", "/v1/main")).toEqual([]);
  expect(spade.sent("PUT", "/v1/main/host")).toEqual([]);
  expect(others.get("studio")?.sent("PUT", "/v1/main/host")).toEqual([]);
});

test("a machine holding an older choice is given the newer one", async () => {
  const { spade } = await spadeApp(
    "/spade",
    (api) => {
      spadeHere(api, 1);
      api.hostRecord = chosen("this-mac", 1);
    },
    {
      machines: [
        {
          hostId: "studio",
          name: "Studio Mac",
          seed: (api) => {
            spadeHere(api, 5);
            api.hostRecord = chosen("studio", 2);
          },
        },
      ],
    },
  );
  await waitFor(() => expect(spade.sent("PUT", "/v1/main/host")).toEqual([chosen("studio", 2)]));
  await waitFor(async () =>
    expect((await botRow("Spade")).getAttribute("href")).toContain("on=studio"),
  );
});
