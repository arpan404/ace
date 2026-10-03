import { DeviceError } from "./sdk.ts";
export type Actor = { kind: "human" | "agent"; owner: string; threadId?: string; agentId?: string };
export class ControllerLease {
  private epoch = 0;
  private actor: Actor | undefined;
  private deadline = 0;
  private readonly now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }
  claim(actor: Actor): void {
    this.actor = actor;
    this.deadline = this.now() + 30000;
    this.epoch++;
  }
  release(owner?: string): void {
    if (owner !== undefined && this.actor?.owner !== owner) return;
    this.actor = undefined;
    this.deadline = 0;
    this.epoch++;
  }
  status(): { controller: "none" | "human" | "agent"; leaseExpiresAt?: number } {
    if (this.now() >= this.deadline) this.release();
    return this.actor
      ? { controller: this.actor.kind, leaseExpiresAt: this.deadline }
      : { controller: "none" };
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
  current(): Actor | undefined {
    this.status();
    return this.actor ? { ...this.actor } : undefined;
  }
  owned(owner: string): boolean {
    this.status();
    return this.actor?.owner === owner;
  }
}
