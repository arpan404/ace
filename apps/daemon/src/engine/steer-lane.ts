import type { Capabilities, ThreadId } from "@ace/protocol";
import type { ThreadActor } from "./actor.ts";
import type { AdapterRegistry } from "./registry.ts";
import type { EngineRepository, IntentHeader } from "./repository.ts";
import { rootRun, steerRoute, type SteerRoute } from "./steer-yield.ts";

interface Ports {
  repo: EngineRepository;
  registry: AdapterRegistry;
  actor(id: ThreadId): ThreadActor | undefined;
  deliver(actor: ThreadActor, intent: IntentHeader): Promise<void>;
  wake(id: ThreadId): void;
  report(error: unknown): void;
}

/**
 * The steering lane: a person's Steer reaches the model now. Where the provider steers natively
 * mid-tool it goes straight in. Where its steer waits for the running command, the lane
 * interrupts the turn first and delivers the message once that turn ends. The message stays an
 * unclaimed intent until then, so a restart in between keeps it, once, for recovery.
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
  async run(actor: ThreadActor): Promise<void> {
    const { repo } = this.ports;
    // The person's steer goes first: a daemon result waiting on a command never holds it.
    const person = repo.pending.personSteer(actor.id);
    const route = person && this.route(person);
    if (person && route === "native") return this.deliver(actor, person);
    if (route === "yield") return this.yieldTurn(actor);
    const next = repo.pending.steerMessage(actor.id);
    if (next && next.id !== person?.id && this.isSteer(next)) return this.deliver(actor, next);
  }
  private async deliver(actor: ThreadActor, intent: IntentHeader): Promise<void> {
    await this.ports.deliver(actor, intent);
    this.ports.wake(actor.id);
  }
  /**
   * Interrupts the root's running turn, once, so the waiting steer goes in as the next input.
   * Only the root turn stops: background commands and children keep running (no cascade).
   */
  private async yieldTurn(actor: ThreadActor): Promise<void> {
    const run = rootRun(this.ports.repo.requireState(actor.id));
    const session = actor.session;
    if (run === undefined || !session) return;
    actor.steerYield = { run, state: "pending" };
    try {
      await session.interrupt({ cascade: false });
    } catch (error) {
      // The turn may have ended meanwhile; otherwise the provider's own steer takes over.
      if (actor.steerYield?.run === run) actor.steerYield = { run, state: "refused" };
      this.ports.report(error);
    }
    this.ports.wake(actor.id);
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
    if (actor.steerYield && actor.steerYield.run !== rootRun(state)) actor.steerYield = undefined;
    return steerRoute(intent, state, capabilities, actor.steerYield);
  }
}
