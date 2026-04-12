import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, expect, vi } from "vitest";

vi.mock("../../processRunner", () => ({
  runProcess: vi.fn(),
}));

import { runProcess } from "../../processRunner";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { GitHubCliLive } from "./GitHubCli.ts";

const mockedRunProcess = vi.mocked(runProcess);
const layer = it.layer(GitHubCliLive);

afterEach(() => {
  mockedRunProcess.mockReset();
});

layer("GitHubCliLive", (it) => {
  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          title: "Add PR thread creation",
          url: "https://github.com/pingdotgg/codething-mvp/pull/42",
          baseRefName: "main",
          headRefName: "feature/pr-threads",
          state: "OPEN",
          mergedAt: null,
          isCrossRepository: true,
          headRepository: {
            nameWithOwner: "octocat/codething-mvp",
          },
          headRepositoryOwner: {
            login: "octocat",
          },
        }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequest({
          cwd: "/repo",
          reference: "#42",
        });
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        [
          "pr",
          "view",
          "#42",
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          nameWithOwner: "octocat/codething-mvp",
          url: "https://github.com/octocat/codething-mvp",
          sshUrl: "git@github.com:octocat/codething-mvp.git",
        }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "octocat/codething-mvp",
        });
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
    }),
  );

  it.effect("passes search text when listing issues", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 77,
            title: "Improve empty state copy",
            state: "OPEN",
            url: "https://github.com/pingdotgg/ace/issues/77",
            body: "Use concise copy.",
            labels: [{ name: "ux" }],
            assignees: [{ login: "octocat" }],
            author: { login: "hubot" },
            createdAt: "2026-04-08T00:00:00.000Z",
            updatedAt: "2026-04-08T00:10:00.000Z",
          },
        ]),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.listIssues({
          cwd: "/repo",
          limit: 20,
          query: "empty state",
        });
      });

      assert.equal(result[0]?.number, 77);
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        [
          "issue",
          "list",
          "--state",
          "open",
          "--limit",
          "20",
          "--search",
          "empty state",
          "--json",
          "number,title,state,url,body,labels,assignees,author,createdAt,updatedAt",
        ],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("passes state and label filters when listing issues", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: "[]",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.listIssues({
          cwd: "/repo",
          state: "all",
          labels: ["bug", "performance"],
        });
      });

      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        [
          "issue",
          "list",
          "--state",
          "all",
          "--limit",
          "30",
          "--label",
          "bug",
          "--label",
          "performance",
          "--json",
          "number,title,state,url,body,labels,assignees,author,createdAt,updatedAt",
        ],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("parses full issue thread details with comments", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 77,
          title: "Improve empty state copy",
          state: "OPEN",
          url: "https://github.com/pingdotgg/ace/issues/77",
          body: "Use concise copy and support issue continuation.",
          labels: [{ name: "ux" }],
          assignees: [{ login: "octocat" }],
          author: { login: "hubot" },
          createdAt: "2026-04-08T00:00:00.000Z",
          updatedAt: "2026-04-08T00:10:00.000Z",
          comments: [
            {
              author: { login: "maintainer" },
              body: "Let's include linked screenshots in context.",
              createdAt: "2026-04-08T00:12:00.000Z",
              updatedAt: "2026-04-08T00:13:00.000Z",
              url: "https://github.com/pingdotgg/ace/issues/77#issuecomment-1",
            },
          ],
        }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getIssueThread({
          cwd: "/repo",
          issueNumber: 77,
        });
      });

      assert.equal(result.number, 77);
      assert.equal(result.comments[0]?.author?.login, "maintainer");
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        [
          "issue",
          "view",
          "77",
          "--json",
          "number,title,state,url,body,labels,assignees,author,createdAt,updatedAt,comments",
        ],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("surfaces a friendly error when the pull request is not found", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockRejectedValueOnce(
        new Error(
          "GraphQL: Could not resolve to a PullRequest with the number of 4888. (repository.pullRequest)",
        ),
      );

      const error = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequest({
          cwd: "/repo",
          reference: "4888",
        });
      }).pipe(Effect.flip);

      assert.equal(error.message.includes("Pull request not found"), true);
    }),
  );

  it.effect("surfaces a friendly error when repository issues are disabled", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockRejectedValueOnce(
        new Error("the 'octocat/example' repository has disabled issues"),
      );

      const error = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.listIssues({
          cwd: "/repo",
          state: "open",
        });
      }).pipe(Effect.flip);

      assert.equal(error.message.includes("GitHub issues are disabled for this repository"), true);
    }),
  );
});
