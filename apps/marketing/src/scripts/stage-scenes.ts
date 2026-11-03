import { formatElapsed } from "@ace/ui-core/time";

/*
 * What each scene of the drawn Mac does (components/mac). A scene first puts the drawing in
 * one known state (`show`), then acts through `Act`, which stage-story.ts provides: the
 * pointer moves to real elements and "clicks" them, and the scene flips the `data-*` state the
 * CSS reads. Every step checks `alive()`, so a newer scene stops an older one.
 */

export type Root = HTMLElement;

export interface Act {
  /** False once another scene has started. */
  alive(): boolean;
  wait(ms: number): Promise<void>;
  moveTo(target: Element | null, at?: { x: number; y: number }): Promise<void>;
  click(target: Element | null): Promise<void>;
  type(target: Element | null, text: string, mask?: boolean): Promise<void>;
  tap(target: Element | null): Promise<void>;
  /** Moves the agent's own pointer inside ace's browser page. */
  agentTo(target: Element | null): Promise<void>;
  hidePointer(): void;
}

export type SceneScript = (root: Root, act: Act) => Promise<void>;

const q = (root: ParentNode, selector: string) => root.querySelector<HTMLElement>(selector);
const ace = (root: Root) => q(root, ".ace");
const desktop = (root: Root) => q(root, "[data-desktop]");

function hover(root: Root, selector: string, on: boolean): void {
  q(root, selector)?.classList.toggle("hover", on);
}

/** Opens a thread: its row selected, its title, transcript and strips shown. */
function select(root: Root, id: string): void {
  for (const row of root.querySelectorAll<HTMLElement>("[data-row]")) {
    row.classList.toggle("selected", row.dataset.row === id);
  }
  ace(root)?.setAttribute("data-thread", id);
  for (const part of root.querySelectorAll<HTMLElement>(".ace [data-for]")) {
    part.hidden = part.dataset.for !== id;
  }
}

/** Shows only the threads on one machine, or every thread with `machine` unset. */
function filter(root: Root, machine: string | undefined, label: string): void {
  for (const row of root.querySelectorAll<HTMLElement>("[data-row]")) {
    row.hidden = machine !== undefined && row.dataset.machine !== machine;
  }
  const shown = q(root, "[data-filter-label]");
  if (shown) shown.textContent = label;
}

function tone(root: Root, id: string, kind: string, label?: string): void {
  const row = q(root, `[data-row="${id}"]`);
  if (!row) return;
  row.dataset.tone = kind;
  const time = q(row, ".time");
  if (time && label !== undefined) time.textContent = label;
}

function set(element: HTMLElement | null, name: string, value: string): void {
  element?.setAttribute(name, value);
}

/**
 * Every scene starts from the same app: one thread open, nothing answered, nothing open. Scenes
 * after the cold-start thread handed off its work keep its agents group open (`agents`).
 */
function show(root: Root, state: { thread: string; approved?: boolean; agents?: boolean }): void {
  const app = ace(root);
  if (!app) return;
  select(root, state.thread);
  filter(root, undefined, "All projects");
  set(app, "data-panel", "off");
  set(app, "data-approved", state.approved ? "yes" : "no");
  set(app, "data-moved", "no");
  set(app, "data-device", "yes");
  set(app, "data-cold", "running");
  set(app, "data-agents", state.agents ? "open" : "closed");
  tone(root, "checkout", state.approved ? "done" : "approve", state.approved ? "now" : "");
  tone(root, "webhooks", "limited", "");
  tone(root, "cold-start", "agents", formatElapsed(248_000));
  tone(root, "soak", "working", formatElapsed(248_000));
  const account = q(root, "[data-account]");
  if (account) account.textContent = "P";

  const desk = desktop(root);
  desk?.removeAttribute("data-sim-shown");
  desk?.removeAttribute("data-phone-shown");
  set(q(root, "[data-phone]"), "data-activity", "waiting");
  q(root, "[data-phone-note]")?.classList.remove("on");
  for (const selector of ["[data-menu]", "[data-code-dialog]"])
    q(root, selector)?.classList.remove("open");
  for (const pin of root.querySelectorAll("[data-pin] i")) pin.classList.remove("set");
  for (const element of root.querySelectorAll(".hover")) element.classList.remove("hover");

  set(q(root, "[data-sim]"), "data-screen", "sign-in");
  for (const field of root.querySelectorAll("[data-type]")) field.textContent = "";
  for (const field of root.querySelectorAll(".field.focus")) field.classList.remove("focus");
  const note = q(root, "[data-sim-note]");
  if (note) note.textContent = "Opening Acme";

  for (const step of root.querySelectorAll(".browser-step, .browser-done")) {
    step.classList.add("pending");
  }
  set(q(root, ".site"), "data-site", "cart");
  q(root, "[data-agent-cursor]")?.classList.remove("shown");
}

const reveal = (root: Root, selector: string) => q(root, selector)?.classList.remove("pending");

/** The Simulator comes up beside ace and the agent signs in to the test account on it. */
async function signIn(root: Root, act: Act): Promise<void> {
  desktop(root)?.setAttribute("data-sim-shown", "");
  await act.moveTo(null, { x: 0.45, y: 0.94 });
  const note = q(root, "[data-sim-note]");
  await act.wait(900);
  if (note) note.textContent = "Typing in Email";
  await act.tap(q(root, '[data-target="sim-email"]'));
  await act.type(q(root, '[data-type="email"]'), "test@acme.dev");
  await act.tap(q(root, '[data-target="sim-password"]'));
  await act.type(q(root, '[data-type="password"]'), "hunter2-acme", true);
  if (note && act.alive()) note.textContent = "Tapped Sign in";
  await act.tap(q(root, '[data-target="sim-submit"]'));
  if (!act.alive()) return;
  set(q(root, "[data-sim]"), "data-screen", "code");
  if (note) note.textContent = "On the code screen";
}

export const scenes: Record<string, SceneScript> = {
  async parallel(root, act) {
    show(root, { thread: "cold-start" });
    await act.wait(500);
    // A glance down the list: every thread is doing something, and one waits on you.
    for (const id of ["cold-start", "soak", "staging", "checkout"]) {
      const row = q(root, `[data-row="${id}"]`);
      await act.moveTo(row, { x: 0.6, y: 0.5 });
      if (!act.alive()) return;
      for (const other of root.querySelectorAll(".row.hover")) other.classList.remove("hover");
      row?.classList.add("hover");
    }
  },

  async team(root, act) {
    show(root, { thread: "cold-start" });
    await act.wait(400);
    await act.click(q(root, '[data-target="subagents"]'));
    if (!act.alive()) return;
    set(ace(root), "data-agents", "open");
    await act.wait(1100);
    const remote = q(root, ".agent-row:last-child");
    await act.moveTo(remote, { x: 0.35, y: 0.5 });
    remote?.classList.add("hover");
  },

  async review(root, act) {
    show(root, { thread: "cold-start", approved: true });
    await act.wait(400);
    await act.click(q(root, ".actions .flip"));
    if (!act.alive()) return;
    set(ace(root), "data-panel", "changes");
    await act.wait(900);
    const added = q(root, ".side-changes .line.add");
    await act.moveTo(added, { x: 0.45, y: 0.5 });
    added?.classList.add("hover");
    await act.wait(1100);
    added?.classList.remove("hover");
    await act.moveTo(q(root, '[data-target="commit"]'), { x: 0.4, y: 0.5 });
    hover(root, '[data-target="commit"]', true);
  },

  async computer(root, act) {
    show(root, { thread: "cold-start", approved: true });
    await act.wait(300);
    await act.click(q(root, '[data-row="sign-in"]'));
    if (!act.alive()) return;
    select(root, "sign-in");
    await act.wait(500);
    await signIn(root, act);
  },

  async fleet(root, act) {
    show(root, { thread: "cold-start", approved: true, agents: true });
    await act.wait(400);
    await act.click(q(root, '[data-target="filter"]'));
    if (!act.alive()) return;
    q(root, "[data-menu]")?.classList.add("open");
    await act.wait(500);
    await act.moveTo(q(root, '[data-target="machine-build-server"]'), { x: 0.3, y: 0.5 });
    hover(root, '[data-target="machine-build-server"]', true);
    await act.wait(600);
    await act.click(q(root, '[data-target="machine-build-server"]'));
    if (!act.alive()) return;
    q(root, "[data-menu]")?.classList.remove("open");
    filter(root, "build-server", "build-server");
    await act.wait(300);
    await act.moveTo(q(root, '[data-row="soak"]'), { x: 0.55, y: 0.5 });
  },

  async browser(root, act) {
    show(root, { thread: "cold-start", approved: true });
    await act.wait(300);
    await act.click(q(root, '[data-row="staging"]'));
    if (!act.alive()) return;
    select(root, "staging");
    set(ace(root), "data-panel", "browser");
    await act.moveTo(q(root, ".canvas .reply"), { x: 0.5, y: 3 });
    reveal(root, '[data-browser-step="0"]');
    await act.wait(700);
    reveal(root, '[data-browser-step="1"]');
    await act.agentTo(q(root, '[data-target="pay"]'));
    if (!act.alive()) return;
    const pay = q(root, '[data-target="pay"]');
    pay?.classList.add("pressed");
    await act.wait(160);
    pay?.classList.remove("pressed");
    set(q(root, ".site"), "data-site", "paid");
    reveal(root, '[data-browser-step="2"]');
    await act.wait(800);
    reveal(root, '[data-browser-step="3"]');
    await act.wait(500);
    reveal(root, ".browser-done");
  },

  async devices(root, act) {
    show(root, { thread: "cold-start", approved: true });
    await act.wait(300);
    await act.click(q(root, '[data-row="sign-in"]'));
    if (!act.alive()) return;
    select(root, "sign-in");
    set(ace(root), "data-device", "ask");
    await act.wait(1100);
    await act.click(q(root, '[data-target="allow-device"]'));
    if (!act.alive()) return;
    set(ace(root), "data-device", "yes");
    await act.wait(400);
    await signIn(root, act);
  },

  async phone(root, act) {
    show(root, { thread: "cold-start", approved: true, agents: true });
    act.hidePointer();
    desktop(root)?.setAttribute("data-phone-shown", "");
    await act.wait(1300);
    q(root, "[data-phone-note]")?.classList.add("on");
    await act.wait(2400);
    if (!act.alive()) return;
    set(q(root, "[data-phone]"), "data-activity", "done");
    set(ace(root), "data-cold", "done");
    tone(root, "cold-start", "done", "now");
    tone(root, "soak", "done", "now");
  },

  async remote(root, act) {
    show(root, { thread: "cold-start", approved: true });
    await act.wait(400);
    await act.click(q(root, '[data-target="filter"]'));
    if (!act.alive()) return;
    q(root, "[data-menu]")?.classList.add("open");
    await act.wait(500);
    const machine = '[data-target="machine-workstation"]';
    await act.moveTo(q(root, machine), { x: 0.3, y: 0.5 });
    hover(root, machine, true);
    await act.wait(500);
    await act.click(q(root, machine));
    if (!act.alive()) return;
    q(root, "[data-menu]")?.classList.remove("open");
    q(root, "[data-code-dialog]")?.classList.add("open");
    await act.wait(500);
    for (const pin of root.querySelectorAll("[data-pin] i")) {
      if (!act.alive()) return;
      pin.classList.add("set");
      await act.wait(170);
    }
    await act.click(q(root, '[data-target="unlock"]'));
    if (!act.alive()) return;
    q(root, "[data-code-dialog]")?.classList.remove("open");
    filter(root, "workstation", "workstation");
    await act.wait(300);
    await act.moveTo(q(root, '[data-row="sweep"]'), { x: 0.55, y: 0.5 });
  },

  async accounts(root, act) {
    show(root, { thread: "cold-start", approved: true });
    await act.wait(300);
    await act.click(q(root, '[data-row="webhooks"]'));
    if (!act.alive()) return;
    select(root, "webhooks");
    await act.wait(1000);
    await act.click(q(root, '[data-target="move"]'));
    if (!act.alive()) return;
    set(ace(root), "data-moved", "yes");
    tone(root, "webhooks", "working");
    // The row and the strip start the new run's clock together.
    for (const clock of root.querySelectorAll<HTMLElement>(
      '[data-row="webhooks"] [data-seconds], .strip.after-move [data-seconds]',
    )) {
      clock.dataset.seconds = "4";
      clock.textContent = formatElapsed(4000);
    }
    const account = q(root, "[data-account]");
    if (account) account.textContent = "W";
    await act.wait(300);
    await act.moveTo(q(root, ".canvas p.after-move"), { x: 0.5, y: 2 });
  },
};
