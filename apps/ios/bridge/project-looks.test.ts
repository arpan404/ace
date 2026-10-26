import { afterEach, expect, test } from "vitest";
import "./test-host.ts";
import { CommandId, DeviceId, WorkspaceId, type CommandPayload } from "@ace/protocol";
import { facts, type FakeDaemon } from "@ace/fake-daemon";
import { followInbox } from "./inbox.ts";
import { followProjectLooks } from "./project-looks.ts";
import { followMachineIdentity } from "./machine-identity.ts";
import { RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

/*
 * Project marks travel once per project, beside the rows that name them: a row carries only its
 * project's id, and a look is sent again only when the project's look changes.
 */

const image = "data:image/png;base64,iVBORw0KGgo=";
const favicon = "https://example.invalid/favicon.png";

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
});

/** Counts every put by key, so a test can see what was sent again. */
class CountingSink extends RecordingSink {
  readonly counts = new Map<string, number>();
  override put(key: string, read: () => Record<string, unknown> | undefined): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    super.put(key, read);
  }
}

let commands = 0;
function command(daemon: FakeDaemon, payload: CommandPayload) {
  daemon.command({
    id: CommandId.parse(`look-${++commands}`),
    deviceId: DeviceId.parse("seed"),
    payload,
  });
}

function thread(daemon: FakeDaemon, id: string, workspace: string, extra: object = {}) {
  daemon.createThread({
    id,
    workspaceId: workspace,
    title: `Work in ${workspace}`,
    provider: "codex",
    hasSentMessage: true,
    details: {
      workspace: { id: workspace, name: workspace, path: `/fake/${workspace}`, ...extra },
    },
  });
  daemon.apply(id, [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
}

async function following(seed: (daemon: FakeDaemon) => void) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  seed(daemon);
  await client.start();
  const sink = new CountingSink();
  closers.push(followInbox(client, "mac", sink, { now: () => 5_000, set: () => () => {} }));
  closers.push(followProjectLooks(client, sink));
  return { daemon, client, sink };
}

const look = (sink: RecordingSink, id: string) => sink.read(`project:${id}`)?.look;

test("a row names its project, and the project's own image, chosen glyph or favicon arrives once beside it", async () => {
  const { sink } = await following((daemon) => {
    thread(daemon, "t-relay", "relay", { icon: image });
    thread(daemon, "t-docs", "docs");
    thread(daemon, "t-site", "site", { defaultIcon: favicon });
    thread(daemon, "t-scratch", "scratch");
    command(daemon, {
      type: "workspace.update",
      workspaceId: WorkspaceId.parse("docs"),
      name: "docs",
      badge: { glyph: "rocket", color: "violet" },
    });
  });
  await until(() => look(sink, "site") !== undefined, "project looks");
  expect(look(sink, "relay")).toEqual({ image, glyph: null });
  expect(look(sink, "docs")).toEqual({ image: null, glyph: "rocket" });
  expect(look(sink, "site")).toEqual({ image: favicon, glyph: null });
  // Initials-only projects need nothing beyond the row's own badge.
  expect(sink.counts.has("project:scratch")).toBe(false);
  const row = sink.read("inbox:t-relay")?.row as Record<string, unknown>;
  expect(row.workspaceId).toBe("relay");
  expect(JSON.stringify(row)).not.toContain(image);
});

test("row updates never resend a look; an edited badge is sent again and a cleared one clears it", async () => {
  const { daemon, sink } = await following((seeded) => {
    thread(seeded, "t-docs", "docs");
    command(seeded, {
      type: "workspace.update",
      workspaceId: WorkspaceId.parse("docs"),
      name: "docs",
      badge: { glyph: "leaf" },
    });
  });
  await until(() => look(sink, "docs") !== undefined, "docs look");
  const rowPuts = sink.counts.get("inbox:t-docs") ?? 0;
  daemon.apply("t-docs", [
    { type: "turn.started", agent: "root", nativeTurnId: "turn-2", trigger: "user" },
  ]);
  await until(() => (sink.counts.get("inbox:t-docs") ?? 0) > rowPuts, "row update");
  expect(sink.counts.get("project:docs")).toBe(1);

  command(daemon, {
    type: "workspace.update",
    workspaceId: WorkspaceId.parse("docs"),
    name: "docs",
    badge: { glyph: "star" },
  });
  await until(() => (look(sink, "docs") as { glyph?: string } | null)?.glyph === "star", "edit");
  command(daemon, {
    type: "workspace.update",
    workspaceId: WorkspaceId.parse("docs"),
    name: "docs",
    badge: null,
  });
  await until(() => look(sink, "docs") === null, "cleared");
  expect(sink.counts.get("project:docs")).toBe(3);
});

test("the machine's chosen mark is sent by icon name, and a machine that chose none reads as a laptop", async () => {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  await client.start();
  const plain = new RecordingSink();
  closers.push(followMachineIdentity(client, plain));
  await until(() => plain.read("machine:identity") !== undefined, "default mark");
  expect(plain.read("machine:identity")?.glyph).toBe("laptop");

  daemon.services.settings.seed({ "host.icon": { kind: "server", color: "blue" } });
  const chosen = new RecordingSink();
  closers.push(followMachineIdentity(client, chosen));
  await until(() => chosen.read("machine:identity") !== undefined, "chosen mark");
  expect(chosen.read("machine:identity")?.glyph).toBe("hard-drives");
});
