import { CommandId, DeviceId, WorkspaceId } from "@ace/protocol";
import { facts, type FakeDaemon } from "@ace/fake-daemon";

/*
 * One finished thread in each kind of project mark, so the inbox rows show every case: a
 * project with the person's own image, one with a chosen glyph and colour, one with only the
 * favicon found in its folder, and one with initials only (as `ace` itself is). The images are
 * plain shapes made for the fixture. No provider process runs.
 */

const customImage =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAiUlEQVR42mOQ03D7P5CYYdQBQ9IBHxbYYMU0dQAuSyl1DAMtLCfFEQy0spxYRzDQ0nJiHMFAjuXU1MNALYPI1ctAbjYjRY4qDiA2XRBjBl4HkOpzUtVS5ABSU/2oA4afA+iSCAc8Gw7agoiuRfGAV0aDojoeFA2SQdEkGxSN0kHRLB/tGQ1bBwAATGj9ajD/l7AAAAAASUVORK5CYII=";
const favicon =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAaklEQVR42u3WwQkAIAxDUQdzMAdzP8WroLbaNggJ9PzfsSlxHPfzci1tHDQOQ0ABczwUsYqHIE5xdwQUII27ILRxU8Rt3AwBBbzGnxBW8SuEdVyNgAK84iKEd3yLiIovEVBAdBz6ynHcvA4OKgDufguaygAAAABJRU5ErkJggg==";

type Machine = { host: string; name: string };

export function seedProjectMarks(daemon: FakeDaemon, machine: Machine): void {
  const projects = [
    {
      id: "relay",
      name: "relay",
      title: "Batch relay acknowledgements",
      extra: { icon: customImage },
    },
    { id: "docs-site", name: "docs-site", title: "Rewrite the pairing guide", extra: {} },
    {
      id: "web-app",
      name: "web-app",
      title: "Fix the favicon cache",
      extra: { defaultIcon: favicon },
    },
    { id: "scratch", name: "scratch", title: "Try the new parser", extra: {} },
  ];
  for (const project of projects) {
    const id = `ios-mark-${project.id}`;
    daemon.createThread({
      hasSentMessage: true,
      id,
      workspaceId: project.id,
      title: project.title,
      provider: project.id === "docs-site" ? "claude" : "codex",
      details: {
        workspace: {
          id: project.id,
          name: project.name,
          path: `/tmp/${project.id}`,
          ...project.extra,
        },
        branch: "main",
        machine,
      },
    });
    daemon.apply(id, [
      facts.rootAgent(project.id === "docs-site" ? "claude" : "codex"),
      facts.turn("root"),
      facts.endTurn("root"),
    ]);
  }
  // The badge is chosen the way a client chooses it: through the daemon's own command.
  daemon.command({
    id: CommandId.parse("ios-spike-badge-docs"),
    deviceId: DeviceId.parse("ios-spike-seed"),
    payload: {
      type: "workspace.update",
      workspaceId: WorkspaceId.parse("docs-site"),
      name: "docs-site",
      badge: { glyph: "book", color: "violet" },
    },
  });
}
