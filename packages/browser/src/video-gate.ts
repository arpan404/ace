/*
 * Which encoded chunks get through a link that is backed up: the desktop's backend socket
 * (ADR 0088, embedded backend) and the Simulator transcoder's input pipe. Video is never queued
 * here and never closes the link: a chunk the link refuses is dropped. A delta decodes only after every chunk since its keyframe, so once one of
 * an encode's chunks is dropped, its later deltas are dropped too until a keyframe gets through,
 * and the encoder is asked for that keyframe. Pure: the send is passed in.
 */

export interface ChunkOutcome {
  sent: boolean;
  /** Ask the encoder for a keyframe for this encode now. */
  keyframe: boolean;
}

export class VideoChunkGate {
  /** Encodes, per capture, that dropped a chunk and wait for a keyframe. */
  private broken = new Map<string, Set<string>>();

  offer(capture: string, encode: string, key: boolean, send: () => boolean): ChunkOutcome {
    const waiting = this.broken.get(capture)?.has(encode) === true;
    if (waiting && !key) return { sent: false, keyframe: false };
    if (send()) {
      this.heal(capture, encode);
      return { sent: true, keyframe: false };
    }
    let encodes = this.broken.get(capture);
    if (!encodes) {
      encodes = new Set();
      this.broken.set(capture, encodes);
    }
    encodes.add(encode);
    // The first drop asks for a keyframe; so does a dropped keyframe, which the encoder
    // considers delivered.
    return { sent: false, keyframe: !waiting || key };
  }

  /** The capture ended: nothing is owed for it any more. */
  forget(capture: string): void {
    this.broken.delete(capture);
  }

  private heal(capture: string, encode: string): void {
    const encodes = this.broken.get(capture);
    if (!encodes?.delete(encode) || encodes.size) return;
    this.broken.delete(capture);
  }
}
