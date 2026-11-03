import type { ProviderKind } from "@ace/protocol";
import type { FeatureSlug } from "./features.ts";

/*
 * The home page's story: ace drawn as it looks, on a Mac, acting out one scene per step as the
 * visitor scrolls (components/mac, scripts/stage-story.ts). The threads, transcripts and
 * captions live here; the components only lay them out.
 */

/** The home page's five scenes, then the scenes only a feature page plays. */
export type SceneId =
  | "agents"
  | "approve"
  | "review"
  | "computer"
  | "fleet"
  | "browser"
  | "devices"
  | "phone"
  | "remote"
  | "accounts";

export interface Scene {
  id: SceneId;
  title: string;
  body: string;
  /** The feature page this scene is part of. */
  feature: FeatureSlug;
}

export const scenes: Scene[] = [
  {
    id: "agents",
    title: "Every agent, one window",
    body: "Claude Code, Codex and Cursor side by side. Each thread shows what its agents and commands are doing right now.",
    feature: "status",
  },
  {
    id: "approve",
    title: "It asks, you answer",
    body: "When an agent needs a decision, ace tells you. Answer it and the agent carries on, here or from your phone.",
    feature: "mobile",
  },
  {
    id: "review",
    title: "Review next to the conversation",
    body: "Every thread works in its own worktree. Read the diff, comment on a line, then commit and push from the same panel.",
    feature: "review",
  },
  {
    id: "computer",
    title: "Agents use your apps",
    body: "Agents drive simulators and desktop apps in the background while you keep working, and you can take over at any time.",
    feature: "computer-use",
  },
  {
    id: "fleet",
    title: "Every machine you own",
    body: "Your laptop, a Linux build server and a Windows workstation in one list. Sign in once and reach them from anywhere.",
    feature: "fleet",
  },
];

/** How a thread row's status reads: the app's own glyph per state. */
export type RowState =
  | { kind: "approve" }
  | { kind: "agents"; count: number; seconds: number }
  | { kind: "working"; seconds: number }
  | { kind: "background"; seconds: number }
  /** Held at a usage limit; `seconds` is how long it has worked once it moves on. */
  | { kind: "limited"; seconds: number }
  | { kind: "done"; label: string };

export interface ThreadRow {
  id: string;
  project: string;
  /** The project's two-letter chip and its hue. */
  chip: string;
  hue: number;
  title: string;
  branch?: string;
  state: RowState;
  pr?: number;
  agents?: number;
  provider: ProviderKind;
  /** The provider account's letter on the mark. */
  account?: string;
  /** Where it runs, when not on this Mac. */
  machine?: "build-server" | "workstation";
  /** Uses a device: a simulator, or a browser. */
  device?: "phone" | "browser";
}

export const rows: ThreadRow[] = [
  {
    id: "checkout",
    project: "billing-api",
    chip: "BA",
    hue: 265,
    title: "Fix flaky checkout test",
    branch: "fix/checkout-flake",
    state: { kind: "approve" },
    provider: "claude",
    account: "P",
  },
  {
    id: "cold-start",
    project: "ace",
    chip: "AC",
    hue: 15,
    title: "Cap cold-start replay at 200 events",
    branch: "fix/cold-start-cap",
    state: { kind: "agents", count: 2, seconds: 324 },
    agents: 2,
    provider: "claude",
    account: "P",
  },
  {
    id: "sign-in",
    project: "ace-mobile",
    chip: "AM",
    hue: 35,
    title: "Test sign-in on iPhone 17 Pro",
    branch: "fix/sign-in-2fa",
    state: { kind: "working", seconds: 96 },
    provider: "claude",
    account: "W",
    device: "phone",
  },
  {
    id: "staging",
    project: "web",
    chip: "WE",
    hue: 210,
    title: "Check the staging checkout",
    branch: "fix/checkout-total",
    state: { kind: "working", seconds: 138 },
    provider: "codex",
    account: "P",
    device: "browser",
  },
  {
    id: "webhooks",
    project: "billing-api",
    chip: "BA",
    hue: 265,
    title: "Refactor billing webhooks",
    branch: "refactor/webhooks",
    state: { kind: "limited", seconds: 4 },
    provider: "claude",
    account: "P",
  },
  {
    id: "dedupe",
    project: "ace",
    chip: "AC",
    hue: 15,
    title: "Dedupe thread events after reconnect",
    branch: "fix/replay-dedupe",
    state: { kind: "agents", count: 2, seconds: 94 },
    pr: 214,
    agents: 2,
    provider: "claude",
    account: "P",
  },
  {
    id: "worktrees",
    project: "ace",
    chip: "AC",
    hue: 15,
    title: "Worktree cleanup when a thread is deleted",
    branch: "fix/worktree-cleanup",
    state: { kind: "working", seconds: 304 },
    pr: 209,
    provider: "codex",
    account: "P",
    machine: "build-server",
  },
  {
    id: "fan-out",
    project: "relay",
    chip: "RE",
    hue: 180,
    title: "Backpressure on broadcast fan-out",
    branch: "perf/fanout",
    state: { kind: "background", seconds: 360 },
    provider: "cursor",
    machine: "build-server",
  },
  {
    id: "install",
    project: "docs-site",
    chip: "DS",
    hue: 50,
    title: "Rewrite the install page for the daemon",
    branch: "docs/install-daemon",
    state: { kind: "working", seconds: 484 },
    pr: 31,
    provider: "opencode",
  },
  {
    id: "sweep",
    project: "billing-api",
    chip: "BA",
    hue: 265,
    title: "Nightly flaky-test sweep",
    branch: "chore/test-sweep",
    state: { kind: "working", seconds: 1260 },
    provider: "codex",
    account: "W",
    machine: "workstation",
  },
  {
    id: "rate-limits",
    project: "api",
    chip: "AP",
    hue: 290,
    title: "Add rate limits to the api",
    branch: "feat/rate-limits",
    state: { kind: "done", label: "now" },
    provider: "claude",
    account: "P",
  },
];

/** The machines on the account, as the thread list's filter names them. */
export const machines = [
  { id: "this-mac", name: "This Mac", note: "macOS", threads: 8, locked: false },
  { id: "build-server", name: "build-server", note: "Linux", threads: 2, locked: false },
  { id: "workstation", name: "workstation", note: "Windows", threads: 1, locked: true },
] as const;

/** The diff the review scene shows: the cold-start thread's last turn. */
export const diff = {
  totals: { added: 9, removed: 3 },
  files: [
    {
      path: "apps/server/src/replay.ts",
      added: 3,
      removed: 2,
      lines: [
        { old: 41, new: 41, text: "  }" },
        { old: 42, new: 42, text: "  onResume(client: Client, cursor: ReplayCursor) {" },
        { old: 43, kind: "del", text: '    client.send({ type: "resume.ack" });' },
        { old: 44, kind: "del", text: "    for (const e of this.thread.events) client.send(e);" },
        {
          new: 43,
          kind: "add",
          text: "    const { events, coldStart } = replayFrom(this.thread, cursor);",
        },
        {
          new: 44,
          kind: "add",
          text: '    client.send({ type: "resume.ack", headSeq: this.thread.seq, coldStart });',
        },
        { new: 45, kind: "add", text: "    for (const e of events) client.send(e);" },
        { old: 45, new: 46, text: "  }" },
      ],
    },
    {
      path: "apps/web/src/relay/outbox.ts",
      added: 6,
      removed: 1,
      lines: [
        { old: 18, new: 18, text: "  async resume(socket: RelaySocket) {" },
        { old: 19, kind: "del", text: "    this.buffer.length = 0;" },
        {
          new: 19,
          kind: "add",
          text: "    // keep the buffer until the daemon confirms the resume",
        },
        {
          old: 20,
          new: 20,
          text: '    socket.send({ type: "resume", lastAckedSeq: this.acked });',
        },
        { new: 21, kind: "add", text: '    const ack = await socket.waitFor("resume.ack");' },
        { new: 22, kind: "add", text: "    if (ack.coldStart) this.store.markBackfillNeeded();" },
        {
          new: 23,
          kind: "add",
          text: "    for (const msg of this.buffer) socket.send(msg);",
        },
        { new: 24, kind: "add", text: "    this.buffer.length = 0;" },
        { old: 21, new: 25, text: "  }" },
      ],
    },
  ],
} as const;

export type DiffLine = (typeof diff.files)[number]["lines"][number];

/** The feature pages that show a scene of the Mac instead of a product panel. */
export const featureScenes: Record<FeatureSlug, SceneId> = {
  status: "agents",
  review: "review",
  "computer-use": "computer",
  fleet: "fleet",
  browser: "browser",
  devices: "devices",
  mobile: "phone",
  "remote-access": "remote",
  accounts: "accounts",
};

/** The steps the browser scene's agent takes, shown in its thread one by one. */
export const browserSteps = [
  { verb: "Opened", detail: "localhost:5173/checkout" },
  { verb: "Read the page", detail: "42 elements" },
  { verb: "Clicked", detail: "Pay now" },
  { verb: "Read the console", detail: "0 errors · 3 requests" },
] as const;
