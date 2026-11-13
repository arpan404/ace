import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

async function choose(scope: ReturnType<typeof within>, select: string, option: string) {
  await userEvent.click(scope.getByRole("combobox", { name: select }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

test("a machine chosen for a new bot that goes out of reach stays chosen, and Create waits", async () => {
  const { app } = await spadeApp("/spade", spadeHere, {
    machines: [{ hostId: "studio", name: "Studio Mac", seed: withEndpoint }],
  });
  await userEvent.click(await screen.findByRole("button", { name: "New bot" }));
  const form = within(await screen.findByRole("dialog", { name: "New bot" }));
  await userEvent.type(form.getByRole("textbox", { name: "Name" }), "Travel");
  await choose(form, "Runs on", "Studio Mac");
  await userEvent.click(form.getByRole("button", { name: "Model" }));
  await userEvent.click(await screen.findByRole("option", { name: /^Sonnet/ }));
  expect(form.getByRole("button", { name: "Create bot" }).hasAttribute("disabled")).toBe(false);
  app.crashMachine("studio");
  expect(
    await form.findByText(
      "Studio Mac isn't reachable right now. Wait for it, or pick another machine.",
    ),
  ).toBeTruthy();
  expect(form.getByRole("combobox", { name: "Runs on" }).textContent).toContain("Studio Mac");
  expect(form.getByRole("button", { name: "Create bot" }).hasAttribute("disabled")).toBe(true);
});

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
    expect((await botRow("Research")).textContent).toContain(
      "Unavailable · Spade isn't running on Studio Mac",
    ),
  );
  expect((await botRow("Research")).querySelector("svg.bot-face")?.getAttribute("data-state")).toBe(
    "idle",
  );
});

test("two machines showing Spade switch one off, the same one in every window", async () => {
  const { spade, others } = await spadeApp("/spade", (api) => spadeHere(api, 7), {
    machines: [{ hostId: "studio", name: "Studio Mac", seed: (api) => spadeHere(api, 7) }],
  });
  // Made at the same moment: the lower host id ("studio" < "this-mac") keeps Spade.
  await waitFor(() => expect(spade.sent("PUT", "/v1/main")).toEqual([{ enabled: false }]));
  expect(others.get("studio")?.sent("PUT", "/v1/main")).toEqual([]);
});

test("with no machine showing Spade, the chosen one switches it back on", async () => {
  const { spade, others } = await spadeApp("/spade", withEndpoint, {
    machines: [{ hostId: "studio", name: "Studio Mac", seed: withEndpoint }],
  });
  await waitFor(() =>
    expect(others.get("studio")?.sent("PUT", "/v1/main")).toEqual([{ enabled: true }]),
  );
  expect(spade.sent("PUT", "/v1/main")).toEqual([]);
});

test("when the machine keeping Spade goes offline, Spade is the one switched on here, not the away one", async () => {
  const { app, spade } = await spadeApp("/spade", (api) => spadeHere(api, 5), {
    machines: [{ hostId: "studio", name: "Studio Mac", seed: (api) => spadeHere(api, 1) }],
  });
  // The studio's Spade is older: this machine's is switched off and Spade lists from the studio.
  await waitFor(() => expect(spade.sent("PUT", "/v1/main")).toEqual([{ enabled: false }]));
  await waitFor(async () =>
    expect((await botRow("Spade")).getAttribute("href")).toContain("on=studio"),
  );
  app.crashMachine("studio");
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/main")).toEqual([{ enabled: false }, { enabled: true }]),
  );
  await waitFor(async () => {
    const row = await botRow("Spade");
    expect(row.getAttribute("href")).toBe("/spade/main");
    expect(row.textContent).not.toContain("Away");
  });
});
