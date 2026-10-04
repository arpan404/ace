import { ProjectCloneUrl, ProjectName } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  cloneProgress,
  cloneUrlProblem,
  crumbs,
  displayPath,
  parentFolder,
  projectNameProblem,
  projectProblem,
  repositoryName,
  startFolder,
} from "./projects.ts";

const names = [
  "web-app",
  "My Project",
  "café",
  "",
  " padded",
  "trailing ",
  ".",
  "..",
  "ends.",
  ".hidden",
  "a/b",
  "a\\b",
  "tab\there",
  "x".repeat(256),
  "x".repeat(257),
];

test("a folder name passes as you type exactly when the daemon would accept it", () => {
  for (const name of names)
    expect(projectNameProblem(name) === undefined, JSON.stringify(name)).toBe(
      ProjectName.safeParse(name).success,
    );
});

test("a name already used in the parent folder is refused, whatever its case", () => {
  expect(projectNameProblem("Web-App", ["web-app", "docs"])).toMatch(/already a folder/);
  expect(projectNameProblem("api", ["web-app"])).toBeUndefined();
});

const urls = [
  "https://github.com/acme/web.git",
  "https://github.com/acme/web",
  "ssh://git@github.com/acme/web.git",
  "git@github.com:acme/web.git",
  "git@github.com/acme/web.git",
  "http://github.com/acme/web.git",
  "https://user@github.com/acme/web.git",
  "https://user:secret@github.com/acme/web.git",
  "ssh://git:secret@github.com/acme/web.git",
  "https://github.com/acme/my repo.git",
  "file:///srv/repo.git",
  "/srv/repo.git",
  "github.com/acme/web",
  "https://",
  "",
];

test("a clone address passes exactly when the daemon would accept it", () => {
  for (const url of urls)
    expect(cloneUrlProblem(url) === undefined, url).toBe(ProjectCloneUrl.safeParse(url).success);
});

test("an address carrying credentials points to the person's own Git setup", () => {
  expect(cloneUrlProblem("https://me:token@github.com/acme/web.git")).toMatch(
    /your own Git credentials/,
  );
  expect(cloneUrlProblem("http://github.com/acme/web.git")).toMatch(/https/);
});

test("a clone suggests the repository's own name for its folder", () => {
  expect(repositoryName("https://github.com/acme/web-app.git")).toBe("web-app");
  expect(repositoryName("git@github.com:acme/api.git")).toBe("api");
  expect(repositoryName("ssh://git@host.example/team/tools/")).toBe("tools");
  expect(repositoryName("https://github.com/acme/web?tab=readme")).toBe("web");
  expect(repositoryName("https://github.com/")).toBe("github.com");
  expect(repositoryName("")).toBe("");
});

test("the breadcrumb starts at the home folder for paths inside it, else at the root", () => {
  expect(crumbs("/Users/dev/Code/ace", "/Users/dev")).toEqual([
    { label: "dev", path: "/Users/dev", home: true },
    { label: "Code", path: "/Users/dev/Code", home: false },
    { label: "ace", path: "/Users/dev/Code/ace", home: false },
  ]);
  expect(crumbs("/srv/apps", "/Users/dev")).toEqual([
    { label: "/", path: "/", home: false },
    { label: "srv", path: "/srv", home: false },
    { label: "apps", path: "/srv/apps", home: false },
  ]);
  // A sibling whose name starts like home's is not inside it.
  expect(crumbs("/Users/devops", "/Users/dev")[0]?.label).toBe("/");
});

test("browsing starts at home inside the allowed roots, else at the first root", () => {
  expect(startFolder("/Users/dev", ["/Users/dev"])).toBe("/Users/dev");
  expect(startFolder("/Users/dev", ["/Users"])).toBe("/Users/dev");
  // projects.roots naming only folders outside home: home itself would be refused.
  expect(startFolder("/Users/dev", ["/private/tmp/work", "/srv"])).toBe("/private/tmp/work");
  // A root whose name starts like home's doesn't hold it.
  expect(startFolder("/Users/dev", ["/Users/devops"])).toBe("/Users/devops");
  expect(startFolder(undefined, ["/srv"])).toBe("/srv");
});

test("paths read with the home folder as ~, and the root has no parent", () => {
  expect(displayPath("/Users/dev/Code/ace", "/Users/dev")).toBe("~/Code/ace");
  expect(displayPath("/Users/dev", "/Users/dev")).toBe("~");
  expect(displayPath("/srv/app", "/Users/dev")).toBe("/srv/app");
  expect(parentFolder("/Users/dev/ace")).toBe("/Users/dev");
  expect(parentFolder("/srv")).toBe("/");
  expect(parentFolder("/")).toBeUndefined();
});

test("clone progress only moves forward across Git's phases", () => {
  const steps = [
    cloneProgress("receiving", 0),
    cloneProgress("receiving", 50),
    cloneProgress("receiving", 100),
    cloneProgress("resolving", 40),
    cloneProgress("checkout", 100),
    cloneProgress("completed", undefined),
  ].map((step) => step.value ?? 0);
  expect(steps).toEqual(steps.toSorted((a, b) => a - b));
  expect(steps.at(-1)).toBe(100);
  expect(cloneProgress("starting", undefined).value).toBeUndefined();
});

test("refusals read as sentences, and the ones that close a folder off say so", () => {
  expect(projectProblem("git_auth_failed").message).toMatch(/your own Git credentials/);
  expect(projectProblem("outside_project_roots").denied).toBe(true);
  expect(projectProblem("forbidden").denied).toBe(true);
  expect(projectProblem("destination_not_empty").denied).toBeUndefined();
  expect(projectProblem("something_new").message).toBe("Something went wrong. Try again.");
});
