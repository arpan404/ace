import type { Capabilities, ThreadId } from "@ace/protocol";
import type { ProviderSession } from "@ace/engine-api";
import type { ThreadActor } from "./actor.ts";
import type { AdapterRegistry } from "./registry.ts";
import type { EngineRepository, IntentHeader } from "./repository.ts";
import { isPersonSteer, rootRun, steerRoute, type SteerRoute } from "./steer-yield.ts";
import { steerLostRun } from "./steer-selection.ts";

interface Ports {
  repo: EngineRepository;
  registry: AdapterRegistry;
  actor(id: ThreadId): ThreadActor | undefined;
  deliver(actor: ThreadActor, intent: IntentHeader): Promise<void>;
  wake(id: ThreadId): void;
  report(error: unknown): void;
}

/**
 * The steering lane: a steer reaches the model as soon as the provider allows. Where the
 * provider's own steer waits for the running command, every steer is handed over at once and
 * lands at the next tool boundary. A person's steer (one they sent, or a waiting message they
 * chose to steer in) also gets a running command out of the way: the lane moves it to the
 * background where the session can (Claude), else interrupts the turn and delivers the message
 * once that turn ends. The message stays an unclaimed intent until it goes in, so a restart in
 * between keeps it, once, for recovery.
 */
export class SteerLane {
  private ports: Ports;
  constructor(ports: Ports) {
    this.ports = ports;
  }
  /** A steer that goes into the provider natively right now. */
  isSteer(intent: IntentHeader): boolean {
    return this.route(intent) === "native";
  }
  /** The waiting steer that cancelled the previous turn, ready to go next once that turn ends. */
  yielded(actor: ThreadActor): IntentHeader | undefined {
    const yielded = actor.steerYield;
    if (yielded?.state !== "pending" || yielded.intentId === undefined) return undefined;
    const { repo } = this.ports;
    if (rootRun(repo.requireState(actor.id)) !== undefined) return undefined;
    const steer = repo.pending.personSteer(actor.id);
    return steer?.id === yielded.intentId && !repo.pending.hasSelection(steer.id)
      ? steer
      : undefined;
  }
  async run(actor: ThreadActor): Promise<void> {
    const { repo } = this.ports;
    // The person's steer goes first: a daemon result waiting on a command never holds it.
    const person = repo.pending.personSteer(actor.id);
    const route = person && this.route(person);
    if (person && route === "native") return this.steerNow(actor, person);
    if (person && route === "yield") return this.yieldTurn(actor, person);
    const next = repo.pending.steerMessage(actor.id);
    if (next && next.id !== person?.id && this.isSteer(next)) return this.deliver(actor, next);
  }
  /**
   * Delivers the person's steer, then moves the root's running foreground tools to the
   * background where the provider can, so its steer stops waiting for them. Nothing is stopped:
   * each tool keeps running as a background task. If the provider can't, the steer lands when
   * the tool returns, as the provider's own steering does.
   */
  private async steerNow(actor: ThreadActor, intent: IntentHeader): Promise<void> {
    const { repo } = this.ports;
    const session = actor.session;
    const joinsTurn = rootRun(repo.requireState(actor.id)) !== undefined;
    await this.ports.deliver(actor, intent);
    if (
      joinsTurn &&
      session?.backgroundTools &&
      actor.session === session &&
      repo.pending.commandStatus(intent.commandId) === "done"
    )
      try {
        await session.backgroundTools();
      } catch (error) {
        this.ports.report(error);
      }
    this.ports.wake(actor.id);
  }
  private async deliver(actor: ThreadActor, intent: IntentHeader): Promise<void> {
    await this.ports.deliver(actor, intent);
    this.ports.wake(actor.id);
  }
  /**
   * Interrupts the root's running turn, once, so the waiting steer goes in as the next input.
   * Only the root turn stops: background commands and children keep running (no cascade).
   */
  private async yieldTurn(actor: ThreadActor, intent: IntentHeader): Promise<void> {
    const { repo } = this.ports;
    const run = rootRun(repo.requireState(actor.id));
    const session = actor.session;
    if (run === undefined || !session) return;
    const target = this.aim(intent, session);
    if (target !== undefined && steerLostRun(repo, actor.id, target)) {
      // A native steer naming a turn that ended goes through delivery, whose fence returns it
      // to the queue, as before.
      if (!session.steerViaCancel) return this.deliver(actor, intent);
      // The turn this steer was sent into is gone. Handing it over now would join the running
      // turn with no fence and hold this lane until that turn ends, so a newer steer could not
      // cancel it. It goes back to the queue as the next message: the sends lane delivers it.
      repo.pending.requeue(intent, "Steer target lost");
      return this.ports.wake(actor.id);
    }
    actor.steerYield = { run, state: "pending", intentId: intent.id };
    try {
      await session.interrupt({ cascade: false });
    } catch (error) {
      // The turn may have ended meanwhile; otherwise the provider's own steer takes over.
      if (actor.steerYield?.run === run) actor.steerYield = { run, state: "refused" };
      this.ports.report(error);
    }
    this.ports.wake(actor.id);
  }
  /**
   * The turn a steer was aimed at: the one its payload names (any provider, as a sender's explicit
   * target always fenced it), else, only where the session steers by cancelling, the one recorded
   * as it was admitted. `undefined` when it names none. Native providers never read the record.
   */
  private aim(intent: IntentHeader, session: ProviderSession): string | null | undefined {
    const stamped = this.ports.repo.pending.steerTarget(intent.id);
    if (stamped !== undefined) return stamped;
    return session.steerViaCancel ? this.ports.repo.steerAims.aim(intent.id) : undefined;
  }
  private route(intent: IntentHeader): SteerRoute {
    const { repo } = this.ports;
    if (
      intent.kind !== "thread.send" ||
      intent.delivery !== "steer" ||
      repo.pending.hasSelection(intent.id) ||
      repo.transitions.guarded(intent.threadId)
    )
      return undefined;
    const state = repo.requireState(intent.threadId);
    if (
      repo.pending.transition(intent.threadId) &&
      // The steer itself counts once claimed; delivery re-checks it after the claim.
      (repo.pending.runningBesides(intent.threadId, intent.id) || repo.quiescent(state))
    )
      return undefined;
    const actor = this.ports.actor(intent.threadId);
    const queue = repo.queue.get(intent.threadId);
    if (
      !actor?.session ||
      queue.paused ||
      queue.limited ||
      repo.pending.recovering(intent.threadId) ||
      !this.ports.registry.has(state.config.provider)
    )
      return undefined;
    const capabilities: Capabilities =
      actor.effectiveCapabilities ??
      this.ports.registry.get(state.config.provider, repo.backend(intent.threadId)).capabilities;
    if (!capabilities.steer) return undefined;
    const run = rootRun(state);
    if (actor.steerYield && run !== undefined && actor.steerYield.run !== run)
      actor.steerYield = undefined;
    if (actor.session.steerViaCancel) {
      const target = this.aim(intent, actor.session);
      // The turn this steer was sent into has ended, so it must not cancel the one running now
      // or hold the lane behind it: yieldTurn sees the lost target and hands the message back to
      // the queue as the next one. A steer admitted before its session opened has no payload
      // target; its recorded aim is what keeps it from cancelling the turn its first prompt starts.
      if (target !== undefined && steerLostRun(repo, intent.threadId, target)) return "yield";
    }
    const person = isPersonSteer(intent, repo.steerNotes.personChose(intent.id));
    return steerRoute({ person }, state, capabilities, actor.steerYield, actor.session);
  }
}
