/**
 * What crossed a shaped link, counted where it arrives. A flight is a run of arrivals in one
 * direction; the next flight starts when the other side's bytes arrive in between, so a client
 * that waits for an answer before sending again starts a new flight each time. Client-to-server
 * flights plus one TCP handshake per connection are the round trips the client waited on.
 */
export interface LinkCounts {
  connections: number;
  /** Bytes delivered to the server. */
  upBytes: number;
  /** Bytes delivered to the client. */
  downBytes: number;
  upFlights: number;
  downFlights: number;
  /** Segments that waited out a retransmission stall. */
  stalls: number;
}

export type LinkDirectionName = "up" | "down";

export const emptyCounts = (): LinkCounts => ({
  connections: 0,
  upBytes: 0,
  downBytes: 0,
  upFlights: 0,
  downFlights: 0,
  stalls: 0,
});

/** Per-connection flight boundaries, summed into one set of counts for the link. */
export class FlightCounter {
  private readonly counts = emptyCounts();
  private readonly last = new Map<number, LinkDirectionName>();

  opened(connection: number): void {
    this.counts.connections++;
    this.last.delete(connection);
  }

  closed(connection: number): void {
    this.last.delete(connection);
  }

  arrived(connection: number, direction: LinkDirectionName, bytes: number): void {
    if (bytes <= 0) return;
    if (this.last.get(connection) !== direction) {
      if (direction === "up") this.counts.upFlights++;
      else this.counts.downFlights++;
      this.last.set(connection, direction);
    }
    if (direction === "up") this.counts.upBytes += bytes;
    else this.counts.downBytes += bytes;
  }

  stalled(segments: number): void {
    this.counts.stalls += segments;
  }

  snapshot(): LinkCounts {
    return { ...this.counts };
  }
}

/** What crossed the link between two snapshots. */
export function countsSince(before: LinkCounts, after: LinkCounts): LinkCounts {
  return {
    connections: after.connections - before.connections,
    upBytes: after.upBytes - before.upBytes,
    downBytes: after.downBytes - before.downBytes,
    upFlights: after.upFlights - before.upFlights,
    downFlights: after.downFlights - before.downFlights,
    stalls: after.stalls - before.stalls,
  };
}

/** Round trips the client waited on: a handshake per new connection, then each flight it sent. */
export const roundTrips = (counts: LinkCounts): number => counts.connections + counts.upFlights;
