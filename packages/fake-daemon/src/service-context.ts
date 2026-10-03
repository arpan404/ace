import type { ThreadView, EventPayload, Thread } from "@ace/protocol";
export interface FakeServiceContext {
  now(): number;
  thread(id: string): ThreadView | undefined;
  threads(): Thread[];
  update(id: string, payload: EventPayload): void;
}
