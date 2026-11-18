import type { ThreadId } from "@ace/protocol";
import type { SuitActive, SuitId, SuitLiveCheck } from "@ace/protocol/suits";

/*
 * Where an agent's `suit_apply` lands (ADR 0150). The Suit a device shows (`appearance.suit`)
 * is that device's own setting, so the daemon never stores it. This hub only decides which
 * sockets hear a `SuitActive`:
 *
 * - A preview goes to every socket that may read the calling thread, now and as more connect
 *   while it runs. The devices it reached are remembered.
 * - A keep, and its undo, go only to the devices that saw that thread's preview. Without a
 *   preview, to the devices that may read the thread right then. A device of that set that is
 *   offline hears it when it reconnects within this daemon run.
 * - Only sockets that asked (`suitWatch`) are attached. Each hears, as it attaches, the preview
 *   showing for it, or `none`, so a preview never outlives the socket or daemon run that showed it.
 *
 * No I/O: sockets and ids are passed in.
 */

export interface LookSocket {
  /** The paired device behind the socket; undefined when it has none. */
  device: string | undefined;
  /** Whether this socket may hear about `threadId` (read scope and thread access). */
  hears(threadId: ThreadId): boolean;
  send(active: SuitActive): void;
  /** Asks the device behind the socket to check the Suit it shows (`suitCheck`). */
  check(check: SuitLiveCheck): void;
}

interface Preview {
  threadId: ThreadId;
  suit: SuitId;
  /** Devices (or sockets, for one without a device) the preview reached. */
  reached: Set<string | LookSocket>;
}

/** At most this many keeps or undos wait for one device to come back. */
const pendingPerDevice = 8;

export class SuitLooks {
  readonly #sockets = new Set<LookSocket>();
  readonly #pending = new Map<string, SuitActive[]>();
  readonly #id: () => string;
  #preview: Preview | undefined;

  constructor(id: () => string) {
    this.#id = id;
  }

  /**
   * A socket that asked to watch: it hears what shows for it now and what waited for its device.
   * Attaching the same socket again only tells it again.
   */
  attach(socket: LookSocket): () => void {
    this.#sockets.add(socket);
    const preview = this.#preview;
    if (preview && socket.hears(preview.threadId)) {
      preview.reached.add(key(socket));
      socket.send({ kind: "preview", suitId: preview.suit });
    } else socket.send({ kind: "none" });
    if (socket.device !== undefined) {
      const waiting = this.#pending.get(socket.device);
      this.#pending.delete(socket.device);
      for (const active of waiting ?? []) socket.send(active);
    }
    return () => this.#sockets.delete(socket);
  }

  /** Shows `suit` from `threadId` (replacing any other preview), or ends that thread's preview. */
  preview(threadId: ThreadId, suit: SuitId | null): void {
    const previous = this.#preview;
    if (suit === null) {
      if (previous?.threadId !== threadId) return;
      this.#preview = undefined;
      this.#sendLive(previous.reached, { kind: "none" });
      return;
    }
    const reached = new Set<string | LookSocket>();
    for (const socket of this.#sockets)
      if (socket.hears(threadId)) {
        reached.add(key(socket));
        socket.send({ kind: "preview", suitId: suit });
      }
    this.#preview = { threadId, suit, reached };
    // Whoever saw the last preview and doesn't see this one goes back to their own look.
    if (previous)
      this.#sendLive(new Set([...previous.reached].filter((target) => !reached.has(target))), {
        kind: "none",
      });
  }

  /**
   * Makes `suit` the setting on the devices that saw `threadId`'s preview, ending it. Returns
   * the undo, which goes to the same devices.
   */
  keep(threadId: ThreadId, suit: SuitId): { restore(): void } {
    const preview = this.#preview?.threadId === threadId ? this.#preview : undefined;
    if (preview) this.#preview = undefined;
    const targets = preview?.reached ?? this.#readers(threadId);
    const keepId = this.#id();
    this.#deliver(targets, { kind: "keep", suitId: suit, keepId });
    return { restore: () => this.#deliver(targets, { kind: "restore", keepId }) };
  }

  /**
   * Asks every connected socket that may read `threadId` (the ones a preview or keep from it
   * reached) to run the live check; returns the sockets asked.
   */
  askCheck(threadId: ThreadId, check: SuitLiveCheck): LookSocket[] {
    const asked: LookSocket[] = [];
    for (const socket of this.#sockets)
      if (socket.hears(threadId)) {
        socket.check(check);
        asked.push(socket);
      }
    return asked;
  }

  #readers(threadId: ThreadId): Set<string | LookSocket> {
    const readers = new Set<string | LookSocket>();
    for (const socket of this.#sockets) if (socket.hears(threadId)) readers.add(key(socket));
    return readers;
  }

  /** To each target's live sockets; a device with none hears it when it reconnects. */
  #deliver(targets: ReadonlySet<string | LookSocket>, active: SuitActive): void {
    const heard = this.#sendLive(targets, active);
    for (const target of targets) {
      if (typeof target !== "string" || heard.has(target)) continue;
      const waiting = this.#pending.get(target) ?? [];
      waiting.push(active);
      this.#pending.set(target, waiting.slice(-pendingPerDevice));
    }
  }

  /** Sends to every connected socket of `targets`; returns the targets reached. */
  #sendLive(targets: ReadonlySet<string | LookSocket>, active: SuitActive): Set<unknown> {
    const heard = new Set<unknown>();
    for (const socket of this.#sockets) {
      const target = key(socket);
      if (!targets.has(target)) continue;
      socket.send(active);
      heard.add(target);
    }
    return heard;
  }
}

const key = (socket: LookSocket): string | LookSocket => socket.device ?? socket;
