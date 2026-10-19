import { z } from "zod";
import { ThreadId } from "./ids.ts";

/**
 * Which threads have an agent using Mac apps right now (computer use), and which apps, for the
 * task list's indicator. A client asks once per connection; the daemon answers with the whole
 * set and sends it again whenever it changes, limited to threads the client may read.
 */
export const ComputerUsingWatch = z.object({
  type: z.literal("computer.using.watch"),
  requestId: z.string().min(1).max(128),
});
export type ComputerUsingWatch = z.infer<typeof ComputerUsingWatch>;
export const ComputerUsing = z.object({
  type: z.literal("computer.using"),
  threads: z
    .array(
      z.object({
        threadId: ThreadId,
        /** App names, in the order the agent started using them. */
        apps: z.array(z.string().min(1).max(200)).min(1).max(16),
      }),
    )
    .max(512),
});
export type ComputerUsing = z.infer<typeof ComputerUsing>;
