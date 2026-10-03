import type { ThreadView, EventPayload, Thread } from "@ace/protocol";
export interface FakeServiceContext {
  now(): number;
  createThread?(input: {
    id: string;
    workspaceId: string;
    title: string;
    provider: Thread["provider"];
  }): void;
  apply?(id: string, facts: readonly import("@ace/core").Fact[]): void;
  thread(id: string): ThreadView | undefined;
  threads(): Thread[];
  update(id: string, payload: EventPayload): void;
}
