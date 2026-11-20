import { checkoutError } from "@ace/ui-core";
import type { FilePort } from "./types.ts";

/*
 * The registry's FilePort over the Files tool's existing read and versioned write. The caller
 * hands in one checkout's access per root (its `daemonCheckout(client).read` bound to the
 * thread, and `fileManagement(client, threadId).mutate`), so reading and writing stay in the
 * one place that owns them.
 */

/** A read as the Files tool returns it: text, missing, or another kind the editor can't take. */
export type CheckoutRead =
  | { kind: "text"; text: string; version: string }
  | { kind: "missing" }
  | { kind: string };

export type CheckoutWrite =
  | { op: "write"; path: string; expected: string; text: string }
  | { op: "create"; path: string; expected: null; text: string };

export interface CheckoutAccess {
  read(path: string, signal?: AbortSignal): Promise<CheckoutRead>;
  mutate(operation: CheckoutWrite): Promise<{ version: string | null }>;
}

const isText = (read: CheckoutRead): read is Extract<CheckoutRead, { kind: "text" }> =>
  read.kind === "text" && "text" in read;

export function checkoutFiles(access: (root: string) => CheckoutAccess): FilePort {
  return {
    async read(key, signal) {
      const read = await access(key.root).read(key.path, signal);
      if (isText(read)) return { kind: "text", text: read.text, version: read.version };
      if (read.kind === "missing") return { kind: "missing" };
      return { kind: "unreadable", reason: read.kind };
    },
    async write(key, text, expected) {
      const operation: CheckoutWrite =
        expected === null
          ? { op: "create", path: key.path, expected, text }
          : { op: "write", path: key.path, expected, text };
      try {
        const result = await access(key.root).mutate(operation);
        if (!result.version)
          throw new Error("Couldn't confirm the saved file. Refresh to check it.");
        return { kind: "saved", version: result.version };
      } catch (error) {
        if (checkoutError(error).code === "CONFLICT") return { kind: "clash" };
        throw checkoutError(error);
      }
    },
  };
}
