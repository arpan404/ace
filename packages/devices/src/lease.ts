import { DeviceError } from "./sdk.ts";
export type Actor = { kind: "human" | "agent"; owner: string; threadId?: string; agentId?: string };
export class ControllerLease {
  private epoch = 0;
  private actor: Actor | undefined;
  private expired: Actor | undefined;
  private deadline = 0;
  private readonly retained = new Map<number, number>();
  private readonly now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }
  claim(actor: Actor): void {
    this.expired = undefined;
    this.actor = actor;
    this.deadline = this.now() + 30000;
    this.epoch++;
  }
  release(owner?: string): void {
    if (owner !== undefined && this.actor?.owner !== owner) return;
    this.expired = undefined;
    this.actor = undefined;
    this.deadline = 0;
    this.epoch++;
  }
  status(): {
    controller: "none" | "human" | "agent";
    leaseExpiresAt?: number;
    holder?: { threadId: string; agentId: string };
  } {
    if (this.actor && this.retained.has(this.epoch)) this.deadline = this.now() + 30000;
    if (this.actor && this.now() >= this.deadline) {
      const expired = this.actor;
      this.release();
      this.expired = expired;
    }
    return this.actor
      ? {
          controller: this.actor.kind,
          leaseExpiresAt: this.deadline,
          ...(this.actor.kind === "agent" && this.actor.threadId && this.actor.agentId
            ? { holder: { threadId: this.actor.threadId, agentId: this.actor.agentId } }
            : {}),
        }
      : { controller: "none" };
  }
  /** Pending actions keep their ticket alive, but takeover still invalidates it. */
  retain(actor: Actor, epoch: number): () => void {
    this.assert(actor, epoch);
    this.retained.set(epoch, (this.retained.get(epoch) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.retained.get(epoch) ?? 0;
      if (count > 1) this.retained.set(epoch, count - 1);
      else this.retained.delete(epoch);
    };
  }
  ticket(actor: Actor): number {
    this.assert(actor);
    return this.epoch;
  }
  assert(actor: Actor, epoch = this.epoch): void {
    if (!this.holds(actor, epoch))
      throw new DeviceError(
        "lease_required",
        "Controller lease required",
        "Ask the user to delegate this device or take control in the device panel.",
      );
    this.deadline = this.now() + 30000;
  }
  holds(actor: Actor, epoch: number): boolean {
    this.status();
    return (
      epoch === this.epoch && this.actor?.kind === actor.kind && this.actor.owner === actor.owner
    );
  }
  /** Resume only an expired delegation, never a revoked or transferred controller. */
  resume(actor: Actor): boolean {
    this.status();
    if (actor.kind !== "agent" || this.actor || this.expired?.owner !== actor.owner) return false;
    this.claim(actor);
    return true;
  }
  current(): Actor | undefined {
    this.status();
    return this.actor ? { ...this.actor } : undefined;
  }
  owned(owner: string): boolean {
    this.status();
    return this.actor?.owner === owner;
  }
}
