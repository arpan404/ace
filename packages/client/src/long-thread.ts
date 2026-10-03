import type { z } from "zod";
import type {
  TurnsPageRequest,
  ItemsWindowRequest,
  ThreadSearchRequest,
  ThreadCatchUpRequest,
  ThreadReadStateRequest,
  ThreadMarkReadCommand,
} from "@ace/protocol";

type Input<S extends z.ZodType> = Omit<z.input<S>, "type" | "requestId" | "threadId"> & {
  threadId: string;
};
export type TurnsPageInput = Input<typeof TurnsPageRequest>;
export type ItemsWindowInput = Input<typeof ItemsWindowRequest>;
export type ThreadSearchInput = Input<typeof ThreadSearchRequest>;
export type ThreadCatchUpInput = Input<typeof ThreadCatchUpRequest>;
export type ThreadReadStateInput = Input<typeof ThreadReadStateRequest>;
export type ThreadMarkReadInput = Input<typeof ThreadMarkReadCommand>;
