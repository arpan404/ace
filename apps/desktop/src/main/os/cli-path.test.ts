import { describe, expect, it } from "vitest";
import { planCliPath, profileBlock, startupFiles, withBlock, withoutBlock } from "./cli-path.ts";

const home = "/home/ada";
const facts = {
  platform: "linux" as const,
  home,
  directory: `${home}/.ace/bin`,
  file: `${home}/.ace/bin/ace`,
};

describe("choosing how a terminal finds ace", () => {
  it("leaves PATH alone when another ace comes first", () => {
    expect(
      planCliPath({ ...facts, path: "/usr/bin", found: { path: "/usr/bin/ace", ours: false } }),
    ).toEqual({ kind: "done", status: { state: "other", command: "/usr/bin/ace" } });
  });

  it("is done when PATH already runs this app's command", () => {
    expect(
      planCliPath({
        ...facts,
        path: `/usr/bin:${home}/.local/bin`,
        found: { path: `${home}/.local/bin/ace`, ours: true },
      }),
    ).toEqual({ kind: "done", status: { state: "ready", command: `${home}/.local/bin/ace` } });
  });

  it("links into ~/.local/bin when that folder is on PATH, else edits the shell's profile", () => {
    expect(planCliPath({ ...facts, path: `/usr/bin:${home}/.local/bin/` })).toEqual({
      kind: "link",
      link: `${home}/.local/bin/ace`,
    });
    expect(planCliPath({ ...facts, path: "/usr/bin:/bin" })).toEqual({ kind: "profile" });
  });

  it("asks a Windows user to add the folder themselves", () => {
    const windows = { ...facts, platform: "win32" as const, directory: "C:\\Users\\a\\.ace\\bin" };
    expect(planCliPath({ ...windows, path: "C:\\Windows" })).toMatchObject({
      status: { state: "manual", directory: windows.directory },
    });
  });
});

describe("the shell's startup files", () => {
  const files = (shell: string, platform: NodeJS.Platform, existing: string[] = [], env = {}) =>
    startupFiles({ shell, home, platform, env, existing: (file) => existing.includes(file) }).map(
      (startup) => startup.file,
    );

  it("covers bash's interactive and login shells without hiding an existing .profile", () => {
    expect(files("/bin/bash", "darwin")).toEqual([`${home}/.bashrc`, `${home}/.bash_profile`]);
    expect(files("/bin/bash", "darwin", [`${home}/.profile`])).toEqual([
      `${home}/.bashrc`,
      `${home}/.profile`,
    ]);
    expect(files("/usr/bin/bash", "linux")).toEqual([`${home}/.bashrc`]);
  });

  it("follows ZDOTDIR and XDG_CONFIG_HOME, and writes nothing for csh", () => {
    expect(files("/bin/zsh", "darwin", [], { ZDOTDIR: "/z" })).toEqual(["/z/.zshrc"]);
    expect(files("/usr/bin/fish", "linux", [], { XDG_CONFIG_HOME: "/c" })).toEqual([
      "/c/fish/conf.d/ace.fish",
    ]);
    expect(files("/bin/tcsh", "darwin")).toEqual([]);
  });
});

describe("ace's lines in a startup file", () => {
  it("are added once and removed without touching the person's own lines", () => {
    const own = "export EDITOR=vim\nalias ll='ls -l'\n";
    const block = profileBlock(facts.directory, home);
    const added = withBlock(own, block);
    expect(added.startsWith(own)).toBe(true);
    expect(withBlock(added, block)).toBe(added);
    expect(withoutBlock(added)).toBe(own);
    expect(withoutBlock(withBlock("", block))).toBe("");
  });

  it("replace an earlier block for another folder", () => {
    const old = withBlock("a\n", profileBlock("/old/bin", home));
    const next = withBlock(old, profileBlock(facts.directory, home));
    expect(next).not.toContain("/old/bin");
    expect(withoutBlock(next)).toBe("a\n");
  });
});
