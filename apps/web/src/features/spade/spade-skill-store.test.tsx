import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

function stored(api: FakeSpadeApi, ace: boolean) {
  withEndpoint(api);
  api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  api.skillStore = {
    ace,
    skills: [
      { id: "skl_1", name: "review-code", description: "Review a branch", origin: "ace" },
      { id: "sks_1", name: "release-notes", description: "Write release notes", origin: "spade" },
    ],
  };
}

test("a skill written in Spade is added to ace's library from Settings", async () => {
  const { spade } = await spadeApp("/settings/spade/apps", (api) => stored(api, true));
  const section = within(await screen.findByRole("region", { name: "Skills" }));
  section.getByText("release-notes");
  expect(section.queryByText("review-code")).toBeNull();
  await userEvent.click(section.getByRole("button", { name: "Add to ace's library" }));
  await waitFor(() => expect(spade.sent("POST", "/v1/skills/sks_1/add-to-ace")).toHaveLength(1));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Skills" })).toBeNull());
});

test("with ace away, a skill written in Spade offers no way to add it", async () => {
  await spadeApp("/settings/spade/apps", (api) => stored(api, false));
  const section = within(await screen.findByRole("region", { name: "Skills" }));
  section.getByText("release-notes");
  expect(section.queryByRole("button", { name: "Add to ace's library" })).toBeNull();
});

test("each skill names the bots that use it, and one no bot uses or wrote stays out", async () => {
  await spadeApp("/settings/spade/apps", (api) => {
    stored(api, true);
    api.addAgent({ id: "inbox", kind: "bot", name: "Inbox" });
    api.skillStore.skills = [
      {
        id: "skl_1",
        name: "review-code",
        description: "Review a branch",
        origin: "ace",
        written_by: [],
        used_by: ["inbox"],
      },
      {
        id: "skl_2",
        name: "deploy",
        description: "Ship it",
        origin: "ace",
        written_by: [],
        used_by: [],
      },
      {
        id: "sks_1",
        name: "release-notes",
        description: "Write release notes",
        origin: "spade",
        written_by: ["main"],
        used_by: ["main", "inbox"],
      },
    ];
  });
  const section = within(await screen.findByRole("region", { name: "Skills" }));
  await section.findByText("Inbox");
  expect(section.getByText("Spade, Inbox")).toBeTruthy();
  expect(section.queryByText("deploy")).toBeNull();
});
