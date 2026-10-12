import { expect, test } from "vitest";
import type { GitErrorCode } from "@ace/git";
import {
  stalledFetch,
  transferHarness,
  type FetchFailure,
} from "./repository-transfer-test-support.ts";

const failures: { failure: FetchFailure; code: GitErrorCode }[] = [
  { failure: "timeout", code: "git_timeout" },
  { failure: "cancellation", code: "git_cancelled" },
  { failure: "stream failure", code: "filesystem_error" },
];
test.each(failures)(
  "a fetch $failure keeps provider admission fenced until live-child cleanup is confirmed",
  async ({ failure, code }) => {
    const h = await transferHarness();
    let fetch: Awaited<ReturnType<typeof stalledFetch>> | undefined;
    try {
      const current = await stalledFetch(h);
      fetch = current;
      const error = await current.fail(failure);
      expect(error).toMatchObject({ code });
      expect(() => current.checkAlive()).not.toThrow();
      expect(h.followUp()).toMatchObject({ ok: false, error: "workspace_change_in_progress" });
      await h.engine.flush();
      expect(h.state()).toBe("done");
      await current.stop();
      // Exit alone must not release admission before the supervisor confirms containment.
      expect(h.followUp()).toMatchObject({ ok: false, error: "workspace_change_in_progress" });
      current.containment.resolve({
        status: "confirmed",
        evidence: "Exclusive fixture transport group contained",
      });
      if (!error.cleanup) throw new Error("Missing transfer cleanup receipt");
      await error.cleanup.settled;
      expect(h.followUp()).toMatchObject({ ok: true });
      await h.engine.flush();
      expect(h.state()).toBe("working");
    } finally {
      await fetch?.close();
      await h.close();
    }
  },
);
