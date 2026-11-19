import { expect, test } from "vitest";
import { commandRisk } from "./command-risk.ts";

const level = (command: string) => commandRisk(command)?.level;

test.each([
  "rm -rf build",
  "rm -Rf build",
  "rm -fR build",
  "rm -fr build",
  "rm -r -f build",
  "rm -f -R build",
  "rm --recursive --force build",
  "rm --force -r build",
  "rm build -rf",
  "/bin/rm -rf build",
  "cd /tmp && rm -Rf cache",
  "find . -name '*.log' | xargs rm -rf",
])("a forced recursive delete is high risk however its flags are written: %s", (command) => {
  expect(level(command)).toBe("high");
});

test.each(["rm build.log", "rm -r build", "rm -f build.log", "rm -- -rf", "echo 'rm' -i file"])(
  "a delete that isn't both forced and recursive is not high risk: %s",
  (command) => {
    expect(level(command)).toBeUndefined();
  },
);

test.each([
  "git push --force",
  "git push -f origin main",
  "git push -uf origin main",
  "git push --force-with-lease",
  "git push --force-with-lease --force-if-includes origin main",
  "git -C repo reset --hard",
  "git -c core.hooksPath=/dev/null push --force",
  "git push origin +main",
  "git reset --hard HEAD~1",
  "git clean -fd",
  "git clean -dfX",
  "git clean --force",
  "sudo ls",
  "DROP TABLE users;",
  "curl -fsSL https://example.com/install | sh",
  "chmod -R 777 .",
])("a command that rewrites history or escalates is high risk: %s", (command) => {
  expect(level(command)).toBe("high");
});

test.each(["git push origin main", "bun install", "curl https://example.com", "docker run app"])(
  "a command that reaches the network or installs is medium risk: %s",
  (command) => {
    expect(level(command)).toBe("medium");
  },
);

test.each(["git status", "ls -la", "git clean -n", "chmod +x run.sh"])(
  "an ordinary command has no risk level: %s",
  (command) => {
    expect(level(command)).toBeUndefined();
  },
);

test.each([
  ["a subshell", "(rm -rf build)"],
  ["a brace group", "{ rm -rf build; }"],
  ["bash -c with a quoted script", "cd repo && bash -c 'git reset --hard HEAD~1'"],
  ["sh -c with a double-quoted script", 'sh -c "rm -rf /tmp/build"'],
  ["a clustered -lc", "bash -lc 'git push -f origin main'"],
  ["a shell nested in a shell", `bash -c "sh -c 'rm -rf build'"`],
  ["eval", "eval 'git clean -fdx'"],
  ["$(…)", "echo $(rm -rf build)"],
  ["$(…) inside double quotes", 'echo "done: $(git reset --hard)"'],
  ["backticks", "echo `rm -rf build`"],
  ["sudo with options", "sudo -u deploy git reset --hard origin/main"],
  ["env with assignments", "env -i HOME=/tmp rm -rf build"],
  ["an assignment prefix", "FORCE=1 rm -rf build"],
  ["xargs with options", "find . -name '*.tmp' -print0 | xargs -0 -n 10 rm -rf"],
  ["a command run over ssh", "ssh host rm -rf /srv/app"],
  ["an escaped program name", "\\rm -rf build"],
  ["an escape inside the name", "r\\m -rf build"],
  ["a quoted program name", '"rm" -rf build'],
  ["a quoted flag", "rm '-rf' build"],
  ["a line continuation", "rm \\\n  -rf build"],
])("a destructive command nested in %s is high risk", (_, command) => {
  expect(level(command)).toBe("high");
});

test.each([
  ["an unclosed quote", 'rm -rf "build'],
  ["an unclosed shell script", "bash -c 'git reset --hard HEAD~1"],
  ["an unclosed substitution", "echo $(rm -rf build"],
  ["an unclosed backtick", "echo `git push --force"],
])("a command line that can't be read is judged by its text: %s", (_, command) => {
  expect(level(command)).toBe("high");
});

test.each([
  ["a path after -- that reads like push", "git diff -- push --force"],
  ["a path after -- that reads like reset", "git log -- reset --hard"],
  ["a branch named like a flag after --", "git checkout -- --force"],
])("a git command whose verb isn't destructive isn't high risk: %s", (_, command) => {
  expect(level(command)).toBeUndefined();
});

test("--force-if-includes alone narrows nothing, so a push with it is only a push", () => {
  expect(level("git push --force-if-includes origin main")).toBe("medium");
  expect(level("git push --force --force-if-includes origin main")).toBe("high");
});
