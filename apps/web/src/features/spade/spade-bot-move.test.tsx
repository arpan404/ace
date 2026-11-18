import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const withResearch = (spade: FakeSpadeApi) => {
  withEndpoint(spade);
  spade.addAgent({ id: "research", name: "Research" });
};
const studio = [{ hostId: "studio", name: "Studio Mac", seed: withEndpoint }];

test("Move to… is accepted on the machine picked, then started here, and reads as one sentence with Cancel", async () => {
  const { spade, others } = await spadeApp("/spade/research?profile=details", withResearch, {
    machines: studio,
  });
  await userEvent.click(
    await screen.findByRole("button", { name: "Move Research to another machine" }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: "Studio Mac" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/agents/research/move")).toEqual([
      { to: "studio", move: expect.stringMatching(/^mv_[0-9a-f]{32}$/) },
    ]),
  );
  // Once packed, the person's acceptance went to the studio: that move, that bot, from here,
  // to there, the manifest by its hash, replacing no Spade.
  const [started] = spade.sent("POST", "/v1/agents/research/move");
  await waitFor(() =>
    expect(others.get("studio")?.acceptances.get(String(started?.move))).toEqual({
      bot: "research",
      from: "this-mac",
      via: "dev-this-mac",
      to: "studio",
      digest: "a".repeat(64),
      replaces: "bot",
    }),
  );
  const moving = "Copying Research to Studio Mac, 3 of 12.";
  // In the profile, as its status line, and in the list as the bot's row line.
  await waitFor(() =>
    expect(
      screen.getAllByText(moving).filter((line) => line.closest('[role="status"]')),
    ).toHaveLength(1),
  );
  expect(screen.queryByRole("button", { name: "Move Research to another machine" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(spade.sent("DELETE", "/v1/agents/research/move")).toHaveLength(1));
  await waitFor(() => expect(screen.queryAllByText(moving)).toHaveLength(0));
});

test("a bot that can't move yet says why where the person asked", async () => {
  await spadeApp(
    "/spade/research?profile=details",
    (spade) => {
      withResearch(spade);
      const research = spade.agents.find((agent) => agent.id === "research");
      if (research) spade.status(research, "working", "Reading a page");
    },
    { machines: studio },
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Move Research to another machine" }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: "Studio Mac" }));
  expect(
    await screen.findByText(
      "Research is working; it can move once that ends, or once you stop it.",
    ),
  ).toBeTruthy();
});

test("a failed move says the bot is still here, with Try again and Dismiss", async () => {
  const { spade } = await spadeApp(
    "/spade/research?profile=details",
    (api) => {
      withResearch(api);
      const research = api.agents.find((agent) => agent.id === "research");
      if (research)
        research.move = {
          id: "mv_1",
          to: { host: "studio", name: "Studio Mac" },
          state: "failed",
          problem: "the two machines run different versions of Spade; update both, then move it",
          can_cancel: false,
        };
    },
    { machines: studio },
  );
  expect(
    await screen.findByText(
      "Couldn't move Research to Studio Mac: the two machines run different versions of Spade; update both, then move it. It's still here.",
    ),
  ).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/agents/research/move")).toEqual([
      { to: "studio", move: expect.stringMatching(/^mv_[0-9a-f]{32}$/) },
    ]),
  );
});

test("a bot that arrived names what needs the person until they dismiss it", async () => {
  const { spade } = await spadeApp("/spade/research?profile=details", (api) => {
    withResearch(api);
    const research = api.agents.find((agent) => agent.id === "research");
    if (research)
      research.arrived = {
        from: { host: "laptop", name: "Laptop" },
        routines_paused: 1,
        endpoints: ["Paid"],
      };
  });
  const line =
    "Moved from Laptop. 1 routine is paused until you resume it; add the endpoint Paid on this machine.";
  expect(await screen.findByText(line)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(spade.sent("DELETE", "/v1/agents/research/arrival")).toHaveLength(1));
  await waitFor(() => expect(screen.queryByText(line)).toBeNull());
});

test("Spade read through another machine offers to move here", async () => {
  const { spade, others } = await spadeApp("/spade/main?on=studio&profile=details", withEndpoint, {
    machines: [
      {
        hostId: "studio",
        name: "Studio Mac",
        seed: (api) => {
          withEndpoint(api);
          api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
          api.hostRecord = { host: "studio", version: 1, at: 1, by: "person" };
        },
      },
    ],
  });
  await userEvent.click(await screen.findByRole("button", { name: "Move Spade to this machine" }));
  await waitFor(() =>
    expect(others.get("studio")?.sent("POST", "/v1/agents/main/move")).toEqual([
      { to: "this-mac", move: expect.stringMatching(/^mv_[0-9a-f]{32}$/) },
    ]),
  );
  // Accepted here, on this machine, where Spade is coming, as replacing its quiet Spade.
  await waitFor(() =>
    expect([...spade.acceptances.values()]).toEqual([
      expect.objectContaining({ bot: "main", from: "studio", to: "this-mac", replaces: "main" }),
    ]),
  );
});

test("a move waiting on the other machine after its commit says so, and Check again asks it now", async () => {
  const { spade } = await spadeApp(
    "/spade/research?profile=details",
    (api) => {
      withResearch(api);
      const research = api.agents.find((agent) => agent.id === "research");
      if (research)
        research.move = {
          id: "mv_1",
          to: { host: "studio", name: "Studio Mac" },
          state: "committing",
          waiting: true,
          can_cancel: false,
        };
    },
    { machines: studio },
  );
  // In the profile, and as the bot's line in the list.
  const waiting =
    "Waiting for Studio Mac to finish the move. Research stays here until Studio Mac answers.";
  expect(await screen.findAllByText(waiting)).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(spade.sent("POST", "/v1/agents/research/move/check")).toHaveLength(1));
});
