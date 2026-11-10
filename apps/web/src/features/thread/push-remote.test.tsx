import { gitAction } from "@/test/open-work.ts";
import { facts, type Scenario } from "@ace/fake-daemon";
import type { CommandPayload, ForgeRepository } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

const github: ForgeRepository = { forge: "github", host: "github.com", owner: "acme", name: "ace" };
const gitlab: ForgeRepository = { forge: "gitlab", host: "gitlab.com", owner: "acme", name: "ace" };

/** A finished thread in project `ace`, whose checkout has `origin` on GitHub and `mirror` on GitLab. */
function idle(): Scenario {
  return {
    thread: {
      id: "mirror-push",
      workspaceId: "ace",
      title: "Release from the mirror",
      provider: "claude",
      details: {
        workspace: { id: "ace", name: "ace", path: "/Users/dev/ace" },
        mode: "local",
        worktree: "/Users/dev/ace",
        branch: "release/mirror",
        head: "c".repeat(40),
        ahead: 1,
        behind: 0,
        baseBranch: "main",
        repository: gitlab,
        machine: { host: "fake-host", name: "This Mac" },
      },
    },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("claude"),
          facts.turn("root"),
          facts.message("root", "request", "user", "Release"),
          facts.endTurn("root"),
        ],
      },
    ],
  };
}

test("a project whose primary is its GitLab mirror pushes to the mirror's remote, not the global one", async () => {
  const app = harness({ throughWorker: true });
  app.play(idle()).runUntilBlocked();
  app.daemon.services.settings.seed({
    "sourceControl.preferences": {
      hosts: [{ host: "github.com" }, { host: "gitlab.com" }],
      host: "github.com",
      remote: "origin",
    },
  });
  app.daemon.projects.repositories.set("ace", { added: [], hidden: [github], primary: gitlab });
  const frames: CommandPayload[] = [];
  const receive = app.daemon.command.bind(app.daemon);
  app.daemon.command = (command) => {
    frames.push(command.payload);
    return receive(command);
  };
  await app.open("/t/mirror-push");
  await gitAction(/^Push/);
  const dialog = await screen.findByRole("dialog", { name: /^Push release\/mirror/ });
  await userEvent.click(within(dialog).getByRole("button", { name: "Push" }));
  await waitFor(() =>
    expect(frames.find((frame) => frame.type === "git.push")).toMatchObject({ remote: "mirror" }),
  );
});
