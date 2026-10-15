import { afterEach, expect, test } from "vitest";
import { fakeGh, repository } from "./testing/fixtures.ts";

const signal = () => new AbortController().signal;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const linked = (number: number, state: string) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/octo/ace/pull/${number}`,
  state,
  isDraft: false,
  updatedAt: "2026-10-10T00:00:00Z",
});

test("a deleted PR doesn't break refresh of the others", async () => {
  // GitHub's real partial answer: the missing alias is null and named by a NOT_FOUND error.
  const gh = await fakeGh({
    graphql: [
      {
        body: {
          data: { repository: { pr7: linked(7, "MERGED"), pr8: null, pr9: linked(9, "OPEN") } },
          errors: [
            {
              type: "NOT_FOUND",
              path: ["repository", "pr8"],
              locations: [{ line: 1, column: 80 }],
              message: "Could not resolve to a PullRequest with the number of 8.",
            },
          ],
        },
      },
    ],
  });
  cleanups.push(gh.cleanup);
  const states = await gh.forge.states([7, 8, 9], signal());
  expect(states.get(8)).toBeNull();
  expect(states.get(7)).toMatchObject({ number: 7, repo: repository, state: "merged" });
  expect(states.get(9)).toMatchObject({ number: 9, state: "open" });
});

test("an error other than a missing PR still fails the whole batch", async () => {
  const gh = await fakeGh({
    graphql: [
      {
        body: {
          data: { repository: { pr7: linked(7, "OPEN"), pr8: null } },
          errors: [
            { type: "FORBIDDEN", path: ["repository", "pr8"], message: "Resource protected" },
          ],
        },
      },
    ],
  });
  cleanups.push(gh.cleanup);
  await expect(gh.forge.states([7, 8], signal())).rejects.toMatchObject({ kind: "invalid_data" });
});
