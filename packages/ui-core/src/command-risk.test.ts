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
