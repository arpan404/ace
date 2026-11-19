import { ThreadId } from "@ace/protocol";
import type {
  Device,
  MachineCallOrigin,
  OutboxParcel,
  ParcelAnswer,
  ParcelCall,
  ParcelFacts,
} from "@ace/protocol";
import { TargetRefusal } from "../machines/target-refusal.ts";
import { ParcelFileError, type ParcelFiles } from "./files.ts";
import { admitChunk, heldAfterRestart } from "./rules.ts";
import type { InRow, ParcelRows } from "./store.ts";

export interface ParcelTargetDeps {
  rows: ParcelRows;
  files: ParcelFiles;
  /** The calling device owns the thread here: it, or the thread its tree hangs from, it delegated. */
  owns(device: Device, threadId: string): boolean;
  /** Whether a thread here is a guest session, which no agent runs in. */
  guest(threadId: string): boolean;
  /** Bytes this machine may still take for parcels. */
  room(): number;
  /** The receiving thread is told the parcel arrived (never throws). */
  arrived(row: InRow): void;
  /** A parcel this machine sent back was taken or refused by the calling machine's thread. */
  acknowledged(parcelId: string, outcome: "delivered" | "refused", reason?: string): void;
  now(): number;
}

/** Arriving parcels' writes run one at a time per parcel, so a resend never interleaves. */
class Serial {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

const sameFacts = (a: ParcelFacts, b: ParcelFacts) =>
  a.name === b.name && a.size === b.size && a.sha256 === b.sha256;

/** Where an arriving parcel stands, as the sender reads it. */
const answer = (row: InRow): ParcelAnswer => ({
  state: row.state,
  offset: row.state === "delivered" ? row.facts.size : row.held,
});

/**
 * The receiving end of the `parcel` machine call (ADR 0182), after the grant rules admitted it
 * under Agents. A parcel is taken only for a thread the calling device owns here, never a guest
 * session; one sent back is read only by the device and machine its thread was delegated from.
 */
export function parcelTarget(deps: ParcelTargetDeps) {
  const serial = new Serial();
  /** The arriving parcel, checked to belong to this device and machine. */
  const incoming = (device: Device, origin: MachineCallOrigin, parcelId: string): InRow => {
    const row = deps.rows.in(parcelId);
    if (!row || row.deviceId !== device.id || row.originHost !== origin.hostId)
      throw new TargetRefusal("not_found", "No such parcel from that machine.");
    return row;
  };
  const outgoing = (device: Device, origin: MachineCallOrigin, parcelId: string) => {
    const row = deps.rows.out(parcelId);
    if (
      !row ||
      row.route !== "outbox" ||
      row.deviceId !== device.id ||
      row.originHost !== origin.hostId
    )
      throw new TargetRefusal("not_found", "No such parcel for that machine.");
    return row;
  };
  async function offer(
    device: Device,
    origin: MachineCallOrigin,
    call: Extract<ParcelCall, { action: "offer" }>,
  ): Promise<ParcelAnswer> {
    if (!deps.owns(device, call.to) || deps.guest(call.to))
      throw new TargetRefusal("not_found", "No such thread from that machine.");
    const known = deps.rows.in(call.parcel.parcelId);
    if (known) {
      // The same offer sent again (its answer was lost): where it stands. Anything else reusing
      // the id is refused.
      if (
        known.deviceId !== device.id ||
        known.originHost !== origin.hostId ||
        known.toThread !== call.to ||
        !sameFacts(known.facts, call.parcel)
      )
        throw new TargetRefusal("invalid", "That parcel id is taken.");
      return answer(known);
    }
    if (call.parcel.size > deps.room())
      throw new TargetRefusal("unavailable", "This machine has no room for that parcel now.");
    const now = deps.now();
    deps.rows.insertIn({
      parcelId: call.parcel.parcelId,
      toThread: call.to,
      fromThread: origin.threadId,
      fromMachine: origin.hostName,
      source: "push",
      deviceId: device.id,
      originHost: origin.hostId,
      facts: call.parcel,
      state: "receiving",
      held: 0,
      createdAt: now,
      updatedAt: now,
      notified: false,
    });
    const row = deps.rows.in(call.parcel.parcelId);
    if (!row) throw new TargetRefusal("unavailable");
    return answer(row);
  }
  async function chunk(
    device: Device,
    origin: MachineCallOrigin,
    call: Extract<ParcelCall, { action: "chunk" }>,
  ): Promise<ParcelAnswer> {
    const row = incoming(device, origin, call.parcelId);
    if (row.state !== "receiving") return answer(row);
    const bytes = Buffer.from(call.data, "base64");
    const held = heldAfterRestart(
      await deps.files.heldOnDisk(row.parcelId),
      row.held,
      row.facts.size,
    );
    const admitted = admitChunk({ size: row.facts.size, held }, call.offset, bytes.length);
    // A chunk not at the held offset writes nothing: the answer says where to go on from.
    if (!admitted.ok) {
      if (admitted.refusal === "overrun")
        throw new TargetRefusal("invalid", "That chunk runs past the parcel's size.");
      return { state: row.state, offset: held };
    }
    // Space is counted by bytes held, so it is checked as they come.
    if (bytes.length > deps.room())
      throw new TargetRefusal("unavailable", "This machine has no room for that parcel now.");
    await deps.files.append(row.parcelId, call.offset, bytes);
    deps.rows.updateIn(row.parcelId, { held: held + bytes.length }, deps.now());
    return { state: "receiving", offset: held + bytes.length };
  }
  async function commit(
    device: Device,
    origin: MachineCallOrigin,
    parcelId: string,
  ): Promise<ParcelAnswer> {
    const row = incoming(device, origin, parcelId);
    if (row.state !== "receiving") return answer(row);
    try {
      await deps.files.finish(row.parcelId, row.facts.name, row.facts.size, row.facts.sha256);
    } catch (error) {
      if (error instanceof ParcelFileError && error.code === "corrupt") {
        // Nothing of it is kept: the sender starts over from the first byte.
        deps.rows.updateIn(row.parcelId, { held: 0 }, deps.now());
        return { state: "receiving", offset: 0 };
      }
      throw error;
    }
    deps.rows.updateIn(row.parcelId, { state: "delivered", held: row.facts.size }, deps.now());
    const delivered = deps.rows.in(row.parcelId);
    if (delivered) deps.arrived(delivered);
    return { state: "delivered", offset: row.facts.size };
  }
  async function cancel(
    device: Device,
    origin: MachineCallOrigin,
    parcelId: string,
  ): Promise<ParcelAnswer> {
    const row = deps.rows.in(parcelId);
    // Nothing held is already as cancelled as it gets.
    if (!row) return { state: "cancelled", offset: 0 };
    incoming(device, origin, parcelId);
    if (row.state !== "receiving") return answer(row);
    await deps.files.removeIn(parcelId);
    deps.rows.updateIn(parcelId, { state: "cancelled", held: 0 }, deps.now());
    return { state: "cancelled", offset: 0 };
  }
  function outbox(device: Device, origin: MachineCallOrigin): ParcelAnswer {
    const waiting: OutboxParcel[] = deps.rows.outbox(device.id, origin.hostId).map((row) => ({
      from: ThreadId.parse(row.fromThread),
      to: ThreadId.parse(row.toThread),
      parcel: row.facts,
    }));
    return { outbox: waiting };
  }
  async function read(
    device: Device,
    origin: MachineCallOrigin,
    call: Extract<ParcelCall, { action: "read" }>,
  ): Promise<ParcelAnswer> {
    const row = outgoing(device, origin, call.parcelId);
    if (row.state !== "waiting")
      throw new TargetRefusal("not_found", "That parcel is no longer waiting.");
    if (call.offset >= row.facts.size) return { data: "", offset: row.facts.size };
    const bytes = await deps.files.readOut(row.parcelId, call.offset, call.length);
    return { data: bytes.toString("base64"), offset: call.offset + bytes.length };
  }
  function ack(
    device: Device,
    origin: MachineCallOrigin,
    call: Extract<ParcelCall, { action: "ack" }>,
  ): ParcelAnswer {
    outgoing(device, origin, call.parcelId);
    deps.acknowledged(call.parcelId, call.outcome, call.reason);
    return { acknowledged: true };
  }
  return {
    async handle(
      device: Device,
      origin: MachineCallOrigin,
      call: ParcelCall,
    ): Promise<ParcelAnswer> {
      switch (call.action) {
        case "offer":
          return serial.run(call.parcel.parcelId, () => offer(device, origin, call));
        case "chunk":
          return serial.run(call.parcelId, () => chunk(device, origin, call));
        case "commit":
          return serial.run(call.parcelId, () => commit(device, origin, call.parcelId));
        case "cancel":
          return serial.run(call.parcelId, () => cancel(device, origin, call.parcelId));
        case "outbox":
          return outbox(device, origin);
        case "read":
          return read(device, origin, call);
        case "ack":
          return ack(device, origin, call);
      }
    },
  };
}
export type ParcelTarget = ReturnType<typeof parcelTarget>;
