import type { ClientCore } from "@ace/client";
import { ThreadId, type Interaction, type InteractionResolution } from "@ace/protocol";
import { WholeRequests, type WholeRequestState } from "./summarized-requests.ts";

/*
 * Whole-request reads (ADR 0157) for requests answered without opening their thread: the inbox,
 * the needs-you run and a Spade chat's waiting workers. Each thread gets `summarized-requests.ts`'s
 * `WholeRequests` over the requests last read for it, so a summarized plan loads in full on
 * demand and a yes names the exact version the card showed, as in the open thread.
 */

type Reader = Pick<ClientCore, "readInteraction">;

export class NeedsWhole {
  /** Each thread's pending requests as last read, by id. */
  private readonly seen = new Map<string, Map<string, Interaction>>();
  private readonly reads = new Map<string, WholeRequests>();
  private readonly abort = new AbortController();
  private readonly client: Reader;
  private readonly emit: (threadId: string) => void;

  constructor(client: Reader, emit: (threadId: string) => void) {
    this.client = client;
    this.emit = emit;
  }

  /** A thread's pending requests were read again: reads for ones gone or changed follow. */
  saw(threadId: string, interactions: readonly Interaction[]): void {
    this.seen.set(threadId, new Map(interactions.map((each) => [each.id, each])));
    this.reads.get(threadId)?.changed("all");
  }

  /** How far `interaction` has loaded in full; undefined while no read was asked for. */
  state(threadId: string, interaction: Interaction): WholeRequestState | undefined {
    return this.reads.get(threadId)?.state(interaction);
  }

  read(threadId: string, interactionId: string, retry = false): void {
    this.of(threadId).read(interactionId, retry);
  }

  /** The answer for the request as it stands, with the version read for a yes to a summarized one. */
  resolution(
    threadId: string,
    interactionId: string,
    build: (interaction: Interaction, readWhole: boolean) => InteractionResolution | undefined,
    version: string | undefined,
  ) {
    return this.of(threadId).resolution(interactionId, build, version);
  }

  /** Nothing waits on the thread any more. */
  forget(threadId: string): void {
    this.seen.delete(threadId);
    this.reads.get(threadId)?.changed("all");
    this.reads.delete(threadId);
  }

  stop(): void {
    this.abort.abort();
  }

  private of(threadId: string): WholeRequests {
    let reads = this.reads.get(threadId);
    if (!reads) {
      const store = { interaction: (id: string) => this.seen.get(threadId)?.get(id) };
      reads = new WholeRequests(
        this.client,
        store,
        ThreadId.parse(threadId),
        this.abort.signal,
        () => this.emit(threadId),
      );
      this.reads.set(threadId, reads);
    }
    return reads;
  }
}
