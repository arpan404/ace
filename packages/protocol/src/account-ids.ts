import { z } from "zod";

/** Account references used by core launch and queue commands, without account service schemas. */
export const AccountInstanceId = z.string().min(1).max(256);
export const AccountId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
