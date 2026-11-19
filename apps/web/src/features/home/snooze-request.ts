import { createContext } from "react";

/**
 * The row whose snooze menu H asked to open (`ThreadList`), until that menu closes: the row's
 * own actions open it where the pointer would, beside its status.
 */
export interface SnoozeRequest {
  /** The list row id (another machine's thread has its own). */
  id: string | undefined;
  done(): void;
}

export const SnoozeRequestContext = createContext<SnoozeRequest>({ id: undefined, done() {} });
