import { z } from "zod";
import type { CommandRunner } from "@ace/forge";
import { execFileSync } from "node:child_process";

/** Script only the CLI HTTP boundary; Git pushes go to a real local bare repository. */
export function scriptedForge() {
  const publications: { number: number; branch: string; base: string }[] = [];
  let ci: "pending" | "success" = "pending";
  let loseCreateResponse = false;
  const runner =
    (cwd: string): CommandRunner =>
    async (request) => {
      const path = request.args[1];
      const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
      const pr = (publication: (typeof publications)[number]) => ({
        number: publication.number,
        node_id: `PR_${publication.number}`,
        title: "Deck fixture",
        html_url: `https://github.com/octo/ace/pull/${publication.number}`,
        state: "open",
        draft: false,
        merged: false,
        mergeable: true,
        head: { sha: revision, ref: publication.branch },
        base: { ref: publication.base },
      });
      let body: unknown = [];
      if (path === "repos/octo/ace/pulls" && request.input) {
        const input = z
          .object({ head: z.string(), base: z.string() })
          .parse(JSON.parse(request.input));
        const publication = {
          number: publications.length + 1,
          branch: input.head,
          base: input.base,
        };
        publications.push(publication);
        if (loseCreateResponse) {
          loseCreateResponse = false;
          throw new Error("Scripted lost create response");
        }
        body = pr(publication);
      } else if (path?.startsWith("repos/octo/ace/pulls?")) body = publications.map(pr);
      else if (path?.match(/^repos\/octo\/ace\/pulls\/\d+$/)) {
        const publication = publications[0];
        if (!publication) throw new Error("No published PR");
        body = pr(publication);
      } else if (path?.includes("/check-runs?"))
        body = {
          check_runs: [
            {
              id: 1,
              name: "acceptance",
              status: ci === "pending" ? "in_progress" : "completed",
              conclusion: ci === "success" ? "success" : null,
              completed_at: null,
            },
          ],
        };
      else if (path === "graphql")
        body = {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              },
            },
          },
        };
      return {
        code: 0,
        truncated: false,
        stdout: `HTTP/1.1 200 OK\r\n\r\n${JSON.stringify(body)}`,
      };
    };
  return {
    runner,
    publications,
    pass: () => {
      ci = "success";
    },
    loseResponse: () => {
      loseCreateResponse = true;
    },
  };
}
