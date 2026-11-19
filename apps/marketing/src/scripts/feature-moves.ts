import { scenes, select, show, tone, type Act } from "./stage-scenes.ts";
import type { PlayedMove } from "./feature-steps.ts";

/*
 * What the drawing does as a feature page's step comes into view (content/features.ts names
 * them). Most are the drawn Mac's own scenes (stage-scenes.ts); the rest put ace's window in
 * the state a step talks about. Every move starts from the same app, so any of them can follow
 * any other. The Mac's window and the phone beside it are separate drawings: a move acts on
 * the Mac through `mac` and sets the phone's Lock Screen itself.
 */

export interface Cast {
  /** The hardware holding the Mac's screen, which scenes act inside. */
  mac: HTMLElement;
  /** The phone standing beside it, when the page has one. */
  phone: HTMLElement | null;
}

type Move = (cast: Cast, act: Act) => Promise<void>;

const q = (root: ParentNode, selector: string) => root.querySelector<HTMLElement>(selector);

/** The Lock Screen as it starts: following the thread, nothing asked yet. */
function resetPhone(phone: HTMLElement | null): void {
  if (!phone) return;
  q(phone, "[data-phone]")?.setAttribute("data-activity", "waiting");
  q(phone, "[data-phone-note]")?.classList.remove("on");
}

/** Every agent under the story's thread has finished, so the thread and its row say Done. */
function finish(mac: HTMLElement, phone: HTMLElement | null): void {
  q(mac, ".ace")?.setAttribute("data-cold", "done");
  tone(mac, "cold-start", "done", "now");
  tone(mac, "soak", "done", "now");
  if (phone) q(phone, "[data-phone]")?.setAttribute("data-activity", "done");
}

/** The thread with its agents listed, as it looks once it has handed off its work. */
async function agents({ mac }: Cast, act: Act): Promise<void> {
  show(mac, { thread: "cold-start", approved: true, agents: true });
  act.hidePointer();
  await act.wait(900);
  if (!act.alive()) return;
  // The helper on the other machine is the one the step talks about.
  q(mac, ".agent-row:last-child")?.classList.add("hover");
}

const moves: Record<PlayedMove, Move> = {
  async rest({ mac }, act) {
    show(mac, { thread: "cold-start", approved: true });
    act.hidePointer();
  },

  agents,

  async "tree-done"(cast, act) {
    await agents(cast, act);
    await act.wait(1400);
    if (!act.alive()) return;
    finish(cast.mac, cast.phone);
  },

  async approval({ mac }, act) {
    show(mac, { thread: "cold-start" });
    await act.wait(300);
    await act.click(q(mac, '[data-row="checkout"]'));
    if (!act.alive()) return;
    select(mac, "checkout");
    await act.moveTo(q(mac, '[data-target="allow"]'), { x: 0.5, y: 0.6 });
  },

  async limit({ mac }, act) {
    show(mac, { thread: "cold-start", approved: true });
    await act.wait(300);
    await act.click(q(mac, '[data-row="webhooks"]'));
    if (!act.alive()) return;
    select(mac, "webhooks");
  },

  async "phone-ask"({ mac, phone }, act) {
    show(mac, { thread: "cold-start", agents: true });
    act.hidePointer();
    await act.wait(700);
    if (!act.alive()) return;
    if (phone) q(phone, "[data-phone-note]")?.classList.add("on");
  },

  async phone({ mac, phone }, act) {
    show(mac, { thread: "cold-start", approved: true, agents: true });
    act.hidePointer();
    await act.wait(1800);
    if (!act.alive()) return;
    finish(mac, phone);
  },

  parallel: ({ mac }, act) => play("parallel", mac, act),
  team: ({ mac }, act) => play("team", mac, act),
  fleet: ({ mac }, act) => play("fleet", mac, act),
  devices: ({ mac }, act) => play("devices", mac, act),
  accounts: ({ mac }, act) => play("accounts", mac, act),
  review: ({ mac }, act) => play("review", mac, act),
  computer: ({ mac }, act) => play("computer", mac, act),
  browser: ({ mac }, act) => play("browser", mac, act),
  remote: ({ mac }, act) => play("remote", mac, act),
};

async function play(id: string, mac: HTMLElement, act: Act): Promise<void> {
  await scenes[id]?.(mac, act);
}

/** Plays a move: the Lock Screen starts over, then the Mac acts it out. */
export async function playMove(move: PlayedMove, cast: Cast, act: Act): Promise<void> {
  resetPhone(cast.phone);
  await moves[move](cast, act);
}
