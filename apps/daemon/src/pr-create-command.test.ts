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
    "gh pr create --fill &",
    "gh pr list --head fix | head -5; echo ---; gh pr create --fill",
    "gh pr create --fill | xargs -I{} gh pr view {}",
    "gh pr create --fill > /tmp/out; cat /tmp/out",
  ])
    expect(createsPullRequest(command), command).toBe(false);
});

test("output shaping around the usual publish flow stays attributable to gh pr create", () => {
  for (const command of [
    "gh pr create --title T --body B 2>&1 | tail -5",
    "cd /w && gh pr create --fill | head -3",
    'cd /w && git push -q -u origin fix 2>&1 | grep -v "^remote:"; gh pr create --title T --body B',
    "git push -q -u origin fix 2>&1 | grep -v remote: && gh pr create --fill | tail -1",
    "cd /w && gh pr create --fill > /tmp/out 2>/tmp/err",
    "gh pr create --fill | tee /tmp/out | tail -2",
    "gh pr create --fill | cat",
  ])
    expect(createsPullRequest(command), command).toBe(true);
});

test("verify steps, heredocs and substitutions before the publish flow stay attributable", () => {
  for (const command of [
    "cd /w && bun run lint 2>&1 | tail -1 && git push -q -u origin fix && gh pr create --fill",
    'cd /w && bun run test a b 2>&1 | grep -E "FAIL|Tests"; git push && gh pr create --title T',
    "cd /w && git add -A && git commit -q -F - <<'EOF'\nTitle\n\nBody\nEOF\n&& git push && gh pr create --fill",
    "cd /w && bun run test $(git ls-files 'x/*.test.ts' | tr '\\n' ' ') 2>&1 | tail -3; git push && gh pr create --fill",
    "sleep 5; gh pr create --fill",
  ])
    expect(createsPullRequest(command), command).toBe(true);
  for (const command of [
    "echo https://github.com/ace/project/pull/9 | tee /tmp/u; gh pr create --fill",
    "gh pr list --json url --jq '.[].url'; gh pr create --fill",
    "curl -s https://ci.example.test/last | grep pull; gh pr create --fill",
    "node -e 'console.log(1)'; gh pr create --fill",
    "python3 - <<'PY'\nprint(1)\nPY\n&& gh pr create --fill",
    "bun -e 'console.log(1)' && gh pr create --fill",
    "git push | xargs -I{} echo {}; gh pr create --fill",
  ])
    expect(createsPullRequest(command), command).toBe(false);
});

test("only a standalone created URL in the workspace repository is accepted", () => {
  expect(
    createdPullRequest("\u001b[32mhttps://github.com/Ace/Project/pull/283\u001b[0m\r", [
      repository,
    ]),
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
    expect(createdPullRequest(line, [repository])).toBeUndefined();
});

test("an agent's PR on the fork's parent or an Enterprise host is accepted", () => {
  const parent = { ...repository, owner: "upstream" };
  expect(
    createdPullRequest("https://github.com/upstream/project/pull/9", [repository, parent]),
  ).toEqual({ repository: parent, number: 9 });
  const enterprise = { ...repository, host: "git.example.com" };
  expect(createdPullRequest("https://git.example.com/ace/project/pull/4", [enterprise])).toEqual({
    repository: enterprise,
    number: 4,
  });
  expect(
    createdPullRequest("https://github.com/upstream/project/pull/9", [repository]),
  ).toBeUndefined();
});
