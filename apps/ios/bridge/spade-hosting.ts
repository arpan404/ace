import { parseSpadeMain, type SpadeHostRecord, type SpadeMainState } from "@ace/ui-core/spade-chat";

/*
 * Where this machine's Spade says Spade lives (ADR 0187, `GET /v1/main`), for the Spade tab's
 * list across machines: Swift merges every machine's answer and shows Spade once, from the
 * machine the newest record names (`spadeShownMain` is the rule web follows). A failed read keeps
 * the last answer, so Spade still shows from its host while that host is away.
 */

/** Host records change only on a move or a first choice: read at most this often. */
const mainEvery = 30_000;

export interface SpadeHostingDeps {
  read(path: string): Promise<string>;
  now(): number;
  /** The answer changed: put the state again. */
  changed(): void;
}

/** What Swift holds of it: the record this machine holds (null for none); null before a read. */
export type SpadeHostingWire = { record: SpadeHostRecord | null } | null;

export class SpadeHosting {
  private readonly deps: SpadeHostingDeps;
  private main: SpadeMainState | undefined;
  private readAt: number | undefined;
  private reading = false;

  constructor(deps: SpadeHostingDeps) {
    this.deps = deps;
  }

  /** The machine's ace host id as its Spade reads it, once it has said. */
  get here(): string | undefined {
    return this.main?.here;
  }

  get wire(): SpadeHostingWire {
    return this.main ? { record: this.main.host ?? null } : null;
  }

  /** Read the answer again if the last read is old: on each read of the bots. */
  readDue(): void {
    const at = this.readAt;
    if (at !== undefined && this.deps.now() - at < mainEvery) return;
    this.readNow();
  }

  /** Read the answer again now: on a refresh. */
  readNow(): void {
    if (this.reading) return;
    this.reading = true;
    this.readAt = this.deps.now();
    void this.deps.read("/v1/main").then(
      (body) => {
        this.reading = false;
        const main = parseSpadeMain(body);
        if (!main || same(main, this.main)) return;
        this.main = main;
        this.deps.changed();
      },
      () => {
        // The last answer stays; the next read of the bots tries again.
        this.reading = false;
        this.readAt = undefined;
      },
    );
  }
}

const same = (a: SpadeMainState, b: SpadeMainState | undefined) =>
  b !== undefined && a.here === b.here && JSON.stringify(a.host) === JSON.stringify(b.host);
