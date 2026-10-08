import type { ThreadView, EventPayload, InteractionResolution, Thread } from "@ace/protocol";
export interface FakeWireSession {
  authenticated?(device: string): void;
  handle(message: import("@ace/protocol").ClientMessage, device: string): Promise<void>;
  close(): void;
}
export interface FakeServiceContext {
  now(): number;
  canManageProjects?(device: string): boolean;
  scheduleProject?(callback: () => void): void;
  createThread?(input: {
    id: string;
    workspaceId: string;
    title: string;
    provider: Thread["provider"];
    imported?: Thread["imported"];
  }): void;
  apply?(id: string, facts: readonly import("@ace/core").Fact[]): void;
  thread(id: string): ThreadView | undefined;
  threads(): Thread[];
  update(id: string, payload: EventPayload): void;
  /** Runs after `interaction.resolve` closes an interaction: its thread and adapter key. */
  onResolved?(
    listener: (threadId: string, key: string, resolution?: InteractionResolution) => void,
  ): () => void;
}
