import { z } from "zod";

/**
 * The largest message anyone sends a thread: the UTF-8 bytes of its serialized command. A
 * person's composer message and an agent's text (delegated tasks, thread messages, fork input,
 * automation prompts) share it.
 */
export const maxMessageBytes = 256 * 1024;

/** Text that becomes a message. The serialized message still has to fit `maxMessageBytes`. */
export const MessageText = z.string().min(1).max(maxMessageBytes);
