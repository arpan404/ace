import { CommandId, DeviceId, ThreadId } from "@ace/protocol";
import { facts, type FakeDaemon, type FakeSpadeApi } from "@ace/fake-daemon";

/*
 * Organization spaces on the fixture (ADR 0206 §1.4, §2.3), opt in with
 * `ACE_IOS_SPIKE_SPACE=personal|acme`: a few pinned threads worded for the space, so Personal's
 * and Acme Robotics' lists tell apart at a glance. `acme` also binds the machine's Spade to the
 * organization and shares Builder, whose request the person or Dana Kim may answer. The fake
 * account backend (`spike-account.ts`) lists this machine as Acme's host. No provider runs.
 */

type Details = (branch: string) => Record<string, unknown>;

const titles = {
  personal: [
    ["ios-space-photos", "Back up the photo library", "Copied 2,184 photos to the NAS."],
    ["ios-space-blog", "Draft the blog post on Swift 6", "First draft is in drafts/swift-6.md."],
  ],
  acme: [
    [
      "ios-space-firmware",
      "Calibrate the arm controller firmware",
      "Offsets are within 0.2 mm now.",
    ],
    [
      "ios-space-conveyor",
      "Fix conveyor sensor drift",
      "The drift came from a stale filter window.",
    ],
    ["ios-space-safety", "Review the safety interlock PR", "Two comments left on the e-stop path."],
  ],
} as const;

export function seedSpace(
  daemon: FakeDaemon,
  details: Details,
  space: "personal" | "acme",
  spade: FakeSpadeApi | undefined,
): void {
  for (const [id, title, answer] of titles[space]) {
    daemon.createThread({
      hasSentMessage: true,
      id,
      title,
      provider: "claude",
      workspaceId: "ace",
      details: details(`space/${id}`),
    });
    daemon.apply(id, [
      facts.rootAgent("claude"),
      facts.turn("root"),
      facts.message("root", `${id}-answer`, "assistant", answer),
      facts.endTurn("root"),
    ]);
    daemon.command({
      id: CommandId.parse(`${id}-pin`),
      deviceId: DeviceId.parse("seed"),
      payload: { type: "thread.pin", threadId: ThreadId.parse(id), pinned: true },
    });
  }
  if (space !== "acme" || !spade) return;
  spade.org.binding = {
    org: "org_acme",
    name: "Acme Robotics",
    host: "host_spike",
    policy: 1,
    auditKey: "spike-audit",
  };
  spade.org.access.set("builder", {
    org: "org_acme",
    maker: "acct_dana",
    approvers: ["acct_spike", "acct_dana"],
  });
}

/** Records each thread `daemon` creates from now on; the ids so far on each call. */
export function recordSeeded(daemon: FakeDaemon): () => string[] {
  const ids: string[] = [];
  const create = daemon.createThread.bind(daemon);
  daemon.createThread = (init, agoMs) => {
    ids.push(init.id);
    create(init, agoMs);
  };
  return () => [...ids];
}

/** The space threads `seedSpace` makes. */
const spaceThreads: ReadonlySet<string> = new Set(
  Object.values(titles).flatMap((rows) => rows.map(([id]) => id)),
);

/** Deletes every seeded thread but the space's own; the fixture's timers skip deleted ones. */
export function keepOnlySpaceThreads(daemon: FakeDaemon, seeded: readonly string[]): void {
  for (const id of seeded) if (!spaceThreads.has(id)) daemon.deleteThread(id);
}
