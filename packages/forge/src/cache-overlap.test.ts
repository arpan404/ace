import { expect, test } from "vitest";
import { GitHubForge, type CommandRunner } from "./index.ts";
import { comment, pr, repository, standard } from "./testing/fixtures.ts";

for (const overlap of ["changed", "unchanged", "304", "unequal"]) {
  test(`overlapping ${overlap} responses keep the shared Forge cache within its byte budget`, async () => {
    const signal = new AbortController().signal;
    const large = Array.from({ length: 40 }, (_, index) => ({
      ...comment,
      id: index + 1,
      body: "x".repeat(50000),
    }));
    const defaults = standard();
    const observed = new Map<string, boolean>();
    let mode: "large" | "small" = "large";
    let gate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
    let entered: ReturnType<typeof Promise.withResolvers<void>> | undefined;
    let arrivals = 0;
    const runner: CommandRunner = async ({ args }) => {
      const path = args[1] ?? "";
      observed.set(
        path,
        args.some((value) => value.startsWith("If-None-Match:")),
      );
      let body: unknown;
      let code = 200;
      if (/\/pulls\/\d+$/.test(path)) body = { ...pr, number: Number(path.split("/").at(-1)) };
      else if (path.endsWith("/requested_reviewers")) body = { requested_reviewers: [] };
      else if (/\/pulls\/\d+\/comments\?/.test(path)) {
        const capturedMode = mode;
        if (gate) {
          const arrival = ++arrivals;
          if (arrivals === 2) entered?.resolve();
          await gate.promise;
          if (overlap === "304" && arrival === 2) code = 304;
          body =
            capturedMode === "large" || (overlap === "unchanged" && arrival === 2)
              ? large
              : [{ ...comment, body: overlap === "unequal" ? `edit ${arrival}` : "edit" }];
        } else body = mode === "large" ? large : [{ ...comment, body: "edit" }];
      } else body = defaults[path.replace(/\/(pulls|issues)\/\d+\//, "/$1/7/")]?.[0]?.body;
      return {
        code: 0,
        stderr: "",
        truncated: false,
        stdout: `HTTP/2 ${code}\nETag: "${mode}"\n\n${code === 304 ? "" : JSON.stringify(body)}`,
      };
    };
    const forge = new GitHubForge({ repository, runner, now: () => 0 });
    for (let cycle = 0; cycle < 4; cycle++) {
      mode = "large";
      await forge.status(1, signal);
      mode = "small";
      gate = Promise.withResolvers<void>();
      entered = Promise.withResolvers<void>();
      arrivals = 0;
      const first = forge.status(1, signal);
      const second = forge.status(1, signal);
      await entered.promise;
      gate.resolve();
      await Promise.all([first, second]);
      gate = undefined;
      if (overlap === "unchanged") {
        // Same-version reuse races with a changed publication in a subsequent cycle.
        await forge.status(1, signal);
      }
    }
    mode = "large";
    for (let number = 2; number <= 8; number++) await forge.status(number, signal);
    const resident: boolean[] = [];
    for (let number = 8; number >= 2; number--) {
      await forge.status(number, signal);
      resident.push(observed.get(`repos/octo/ace/pulls/${number}/comments?per_page=100`) ?? false);
    }
    expect(
      resident.slice(0, 5),
      "only four 2 MiB pages fit alongside the small API metadata",
    ).toEqual([true, true, true, true, false]);
    const warm = await forge.status(8, signal);
    expect(await forge.status(8, signal)).toBe(warm);
    expect(warm.comments).toHaveLength(40);
  });
}

for (const disruption of ["invalidation", "eviction"]) {
  for (const response of ["304", "unchanged"]) {
    test(`a late ${response} after ${disruption} counts its retained page before admitting more pages`, async () => {
      const signal = new AbortController().signal;
      const large = Array.from({ length: 40 }, (_, index) => ({
        ...comment,
        id: index + 1,
        body: "x".repeat(50000),
      }));
      const defaults = standard();
      const observed = new Map<string, boolean>();
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      let hold = false;
      const runner: CommandRunner = async ({ args }) => {
        const path = args[1] ?? "";
        observed.set(
          path,
          args.some((value) => value.startsWith("If-None-Match:")),
        );
        let body: unknown;
        let code = 200;
        if (/\/pulls\/\d+$/.test(path)) body = { ...pr, number: Number(path.split("/").at(-1)) };
        else if (path.endsWith("/requested_reviewers")) body = { requested_reviewers: [] };
        else if (/\/pulls\/\d+\/comments\?/.test(path)) {
          body = large;
          if (hold && path.includes("/pulls/1/")) {
            hold = false;
            entered.resolve();
            await gate.promise;
            if (response === "304") code = 304;
          }
        } else body = defaults[path.replace(/\/(pulls|issues)\/\d+\//, "/$1/7/")]?.[0]?.body;
        return {
          code: 0,
          stderr: "",
          truncated: false,
          stdout: `HTTP/2 ${code}\nETag: "large"\n\n${code === 304 ? "" : JSON.stringify(body)}`,
        };
      };
      const forge = new GitHubForge({ repository, runner, now: () => 0 });
      await forge.status(1, signal);
      hold = true;
      const late = forge.status(1, signal);
      try {
        await entered.promise;
        if (disruption === "invalidation") await forge.requestReviews(1, ["reviewer"], signal);
        else for (let number = 2; number <= 5; number++) await forge.status(number, signal);
        gate.resolve();
        await late;
        if (disruption === "invalidation")
          for (let number = 2; number <= 5; number++) await forge.status(number, signal);
        // Probe only hits before the expected miss. A miss cannot evict another
        // page before we observe the four pages that fit in the 8 MiB budget.
        const order = disruption === "invalidation" ? [5, 4, 3, 2, 1] : [1, 5, 4, 3, 2];
        const resident: boolean[] = [];
        for (const number of order) {
          await forge.status(number, signal);
          resident.push(
            observed.get(`repos/octo/ace/pulls/${number}/comments?per_page=100`) ?? false,
          );
        }
        expect(resident).toEqual([true, true, true, true, false]);
      } finally {
        gate.resolve();
        await late;
      }
    });
  }
}
