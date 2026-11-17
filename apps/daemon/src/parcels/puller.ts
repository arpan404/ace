import {
  ParcelAnswer,
  type MachineCallOrigin,
  type OutboxParcel,
  type ParcelCall,
} from "@ace/protocol";
import type { RemoteProfile } from "../cli/profiles.ts";
import { MachineFailure } from "../machines/transport.ts";
import { ParcelFileError, type ParcelFiles } from "./files.ts";
import type { ParcelLink } from "./link.ts";
import { heldAfterRestart, nextRange, retryDelay } from "./rules.ts";
import type { InRow, ParcelRows } from "./store.ts";

export interface ParcelPullerDeps {
  rows: ParcelRows;
  files: ParcelFiles;
  link: ParcelLink;
  profiles(): RemoteProfile[];
  /**
   * Machines with a child of this machine's still unsettled (only they can hold parcels for it),
   * each with one parent here to call as.
   */
  machinesWithChildren(): Map<string, string>;
  /** A child this machine delegated there, with its parent here. */
  remoteChild(id: string): { parentThread: string; machine: string } | undefined;
  /** The parent here exists and isn't deleted. */
  live(threadId: string): boolean;
  origin(threadId: string): Promise<MachineCallOrigin>;
  arrived(row: InRow): void;
  room(): number;
  now(): number;
  log(message: string, fields: Record<string, unknown>): void;
}

const CALL_MS = 30_000;
/** Asking for waiting parcels is short: an unreachable machine mustn't hold up the round. */
const OUTBOX_MS = 5_000;

/**
 * Parcels children on other machines sent back to their parents here (ADR 0182). The machine
 * that holds the link is the one that calls, so it pulls: each round asks every machine with a
 * live child for its waiting parcels, takes only those addressed to that child's own parent,
 * checks each one's SHA-256 here, tells the parent and acknowledges. An acknowledgement lost on
 * the way is sent again next round; the parent is told once.
 */
export class ParcelPuller {
  private deps: ParcelPullerDeps;
  private busy = false;
  /** Machines that failed lately, and when to ask them again. */
  private resting = new Map<string, { failures: number; until: number }>();
  constructor(deps: ParcelPullerDeps) {
    this.deps = deps;
  }
  private async call(
    profile: RemoteProfile,
    threadId: string,
    parcel: ParcelCall,
    signal: AbortSignal,
  ) {
    const { answer } = await this.deps.link.call(
      profile,
      { origin: await this.deps.origin(threadId), call: { op: "parcel", parcel } },
      { timeoutMs: parcel.action === "outbox" ? OUTBOX_MS : CALL_MS, signal },
    );
    const parsed = ParcelAnswer.safeParse(answer);
    if (!parsed.success) throw new MachineFailure("refused", "invalid", "Unreadable answer");
    return parsed.data;
  }
  /** One round over every machine that may hold parcels for this one. */
  async round(signal: AbortSignal): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const machines = this.deps.machinesWithChildren();
      for (const profile of this.deps.profiles()) {
        const asker = machines.get(profile.name);
        if (!asker || signal.aborted) continue;
        const rest = this.resting.get(profile.name);
        if (rest && rest.until > this.deps.now()) continue;
        try {
          await this.machine(profile, asker, signal);
          this.resting.delete(profile.name);
        } catch (error) {
          const failures = (rest?.failures ?? 0) + 1;
          this.resting.set(profile.name, {
            failures,
            until: this.deps.now() + retryDelay(failures),
          });
          if (!(error instanceof MachineFailure) || error.kind === "refused")
            this.deps.log("Parcels couldn't be collected", {
              machine: profile.name,
              error: String(error).slice(0, 200),
            });
        }
      }
    } finally {
      this.busy = false;
    }
  }
  /** Any live child's parent can ask: the answer is every parcel for this device and machine. */
  private async machine(profile: RemoteProfile, asker: string, signal: AbortSignal) {
    const listed = await this.call(profile, asker, { action: "outbox" }, signal);
    if (!("outbox" in listed)) return;
    for (const entry of listed.outbox) await this.take(profile, entry, signal);
  }
  private async take(profile: RemoteProfile, entry: OutboxParcel, signal: AbortSignal) {
    const { deps } = this;
    const { parcel } = entry;
    const child = deps.remoteChild(entry.from);
    const ours = child && child.machine === profile.name && child.parentThread === entry.to;
    if (!ours || !deps.live(entry.to)) {
      await this.call(
        profile,
        child?.parentThread ?? entry.to,
        {
          action: "ack",
          parcelId: parcel.parcelId,
          outcome: "refused",
          reason: "Its parent isn't on this machine.",
        },
        signal,
      ).catch(() => {});
      return;
    }
    let row = deps.rows.in(parcel.parcelId);
    if (!row) {
      if (parcel.size > deps.room()) return;
      const now = deps.now();
      deps.rows.insertIn({
        parcelId: parcel.parcelId,
        toThread: entry.to,
        fromThread: entry.from,
        fromMachine: profile.label ?? profile.name,
        source: "pull",
        deviceId: profile.id,
        originHost: profile.hostId ?? profile.id,
        facts: parcel,
        state: "receiving",
        held: 0,
        createdAt: now,
        updatedAt: now,
        notified: false,
      });
      row = deps.rows.in(parcel.parcelId);
    }
    if (!row || row.source !== "pull" || row.deviceId !== profile.id) return;
    if (row.state === "receiving") {
      let held = heldAfterRestart(await deps.files.heldOnDisk(row.parcelId), row.held, parcel.size);
      for (let range = nextRange(held, parcel.size); range; range = nextRange(held, parcel.size)) {
        const answer = await this.call(
          profile,
          entry.to,
          { action: "read", parcelId: parcel.parcelId, offset: range.offset, length: range.length },
          signal,
        );
        if (!("data" in answer)) return;
        const bytes = Buffer.from(answer.data, "base64");
        if (bytes.length === 0 || bytes.length > range.length) return;
        await deps.files.append(row.parcelId, range.offset, bytes);
        held += bytes.length;
        deps.rows.updateIn(row.parcelId, { held }, deps.now());
      }
      try {
        await deps.files.finish(row.parcelId, parcel.name, parcel.size, parcel.sha256);
      } catch (error) {
        if (error instanceof ParcelFileError && error.code === "corrupt") {
          deps.rows.updateIn(row.parcelId, { held: 0 }, deps.now());
          return;
        }
        throw error;
      }
      deps.rows.updateIn(row.parcelId, { state: "delivered", held: parcel.size }, deps.now());
      const landed = deps.rows.in(row.parcelId);
      if (landed) deps.arrived(landed);
    }
    if (row.state === "cancelled") return;
    await this.call(
      profile,
      entry.to,
      { action: "ack", parcelId: parcel.parcelId, outcome: "delivered" },
      signal,
    );
  }
}
