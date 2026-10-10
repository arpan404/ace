import { expect, test } from "vitest";
import { createsPullRequest, createdPullRequest } from "./pr-create-command.ts";
const repository = { forge: "github", host: "github.com", owner: "ace", name: "project" } as const;

test("recognizes PR creation commands from provider shells with quoted titles and bodies", () => {
  for (const command of [
    "git push -u origin HEAD && gh pr create --fill",
    "cd /workspace && git -C /workspace push && gh pr create --fill",
    "gh pr create --title 'Fix it' --body-file /tmp/body.md",
    "cd /workspace && gh pr create --draft --title 'a; b' --body 'quoted gh pr view'",
    "/bin/zsh -lc 'gh pr create --fill'",
    "GH_HOST=github.com /usr/local/bin/gh -R ace/project pr create --fill",
    "env GH_HOST=github.com gh --repo=ace/project pr create --fill",
    "gh pr create --body \"$(cat <<'EOF'\nBody\nEOF\n)\"",
    "gh pr create \\\n --fill\n",
  ])
    expect(createsPullRequest(command), command).toBe(true);
});

test("commands which only mention PR creation never link mentioned PRs", () => {
  for (const command of [
    "echo 'gh pr create'",
    "printf 'gh pr create\\n'",
    "python -c 'print(\"gh pr create\")'",
    "gh pr view 283",
    "gh pr create --dry-run --body https://github.com/ace/project/pull/9",
    "gh pr create --help",
    "cat <<EOF\ngh pr create\nEOF",
    "# gh pr create\necho done",
    "echo https://github.com/ace/project/pull/9 && gh pr create",
    "gh pr create && gh pr view 9 --json url",
    "echo $(gh pr create)",
    "gh pr create || echo https://github.com/ace/project/pull/9",
  ])
    expect(createsPullRequest(command), command).toBe(false);
});

test("only a standalone created URL in the workspace repository is accepted", () => {
  expect(
    createdPullRequest("\u001b[32mhttps://github.com/Ace/Project/pull/283\u001b[0m\r", repository),
  ).toEqual({ repository, number: 283 });
  for (const line of [
    "See https://github.com/ace/project/pull/283",
    "https://github.com/ace/other/pull/283",
    "https://github.com/other/project/pull/283",
    "https://github.com.evil.test/ace/project/pull/283",
    "https://github.com/ace/project/pull/0",
    "https://github.com/ace/project/pull/9999999999999999999999",
    "https://github.com/ace/project/pull/283/files",
  ])
    expect(createdPullRequest(line, repository)).toBeUndefined();
});
