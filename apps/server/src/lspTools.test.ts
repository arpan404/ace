import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./open", () => ({
  isCommandAvailable: vi.fn(),
}));

vi.mock("./processRunner", () => ({
  runProcess: vi.fn(),
}));

import { isCommandAvailable } from "./open";
import { runProcess } from "./processRunner";
import { getLspToolsStatus, installLspTool, installLspTools } from "./lspTools";

const mockedIsCommandAvailable = vi.mocked(isCommandAvailable);
const mockedRunProcess = vi.mocked(runProcess);

let stateDir: string;

function commandBinaryPath(stateDirectory: string, command: string): string {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  return join(stateDirectory, "lsp-tools", "node_modules", ".bin", `${command}${suffix}`);
}

function uvCommandBinaryPath(stateDirectory: string, command: string): string {
  const suffix = process.platform === "win32" ? ".exe" : "";
  return join(stateDirectory, "lsp-tools", "uv", "bin", `${command}${suffix}`);
}

function goCommandBinaryPath(stateDirectory: string, command: string): string {
  const suffix = process.platform === "win32" ? ".exe" : "";
  return join(stateDirectory, "lsp-tools", "go", "bin", `${command}${suffix}`);
}

describe("lspTools", () => {
  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "ace-lsp-tools-test-"));
    mockedIsCommandAvailable.mockReset();
    mockedRunProcess.mockReset();
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("reports missing tools before installation", async () => {
    const status = await getLspToolsStatus(stateDir);

    expect(status.tools).toHaveLength(18);
    for (const tool of status.tools) {
      expect(tool.installed).toBe(false);
      expect(tool.version).toBeNull();
      expect(tool.binaryPath).toBeNull();
    }
    expect(status.tools.find((tool) => tool.id === "docker-langserver")?.fileNames).toEqual([
      "Dockerfile",
    ]);
  });

  it("installs a curated uv-backed Python server", async () => {
    mockedIsCommandAvailable.mockImplementation((command) => command === "uv");
    mockedRunProcess.mockImplementation(async (command, _args) => {
      if (command !== "uv") {
        throw new Error(`Unexpected command: ${command}`);
      }
      await mkdir(join(stateDir, "lsp-tools", "uv", "bin"), { recursive: true });
      await writeFile(uvCommandBinaryPath(stateDir, "basedpyright-langserver"), "", "utf8");
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      };
    });

    const status = await installLspTool(stateDir, {
      packageName: "basedpyright",
      command: "basedpyright-langserver",
      label: "Python (basedpyright)",
      installer: "uv-tool",
      description: "Fast Python analysis and type checking.",
      installPackages: ["basedpyright==1.39.3"],
      languageIds: ["python"],
      fileExtensions: [".py", ".pyi"],
      fileNames: [],
    });

    expect(mockedRunProcess).toHaveBeenCalledWith(
      "uv",
      expect.arrayContaining(["tool", "install", "--python", "python3", "basedpyright==1.39.3"]),
      expect.objectContaining({
        outputMode: "truncate",
      }),
    );
    expect(status.tools.find((tool) => tool.id === "basedpyright-langserver")).toMatchObject({
      installer: "uv-tool",
      installed: true,
      version: "1.39.3",
    });
  });

  it("installs a curated Go server into ace-managed go bin", async () => {
    mockedIsCommandAvailable.mockImplementation((command) => command === "go");
    mockedRunProcess.mockImplementation(async (command, args) => {
      if (command !== "go") {
        throw new Error(`Unexpected command: ${command}`);
      }
      expect(args).toEqual(["install", "golang.org/x/tools/gopls@latest"]);
      await mkdir(join(stateDir, "lsp-tools", "go", "bin"), { recursive: true });
      await writeFile(goCommandBinaryPath(stateDir, "gopls"), "", "utf8");
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      };
    });

    const status = await installLspTool(stateDir, {
      packageName: "golang.org/x/tools/gopls",
      command: "gopls",
      label: "Go",
      installer: "go-install",
      description: "Official Go language server.",
      installPackages: ["golang.org/x/tools/gopls@latest"],
      languageIds: ["go"],
      fileExtensions: [".go"],
      fileNames: ["go.mod"],
    });

    expect(status.tools.find((tool) => tool.id === "gopls")).toMatchObject({
      installer: "go-install",
      installed: true,
      binaryPath: goCommandBinaryPath(stateDir, "gopls"),
    });
  });

  it("detects a rustup-installed rust-analyzer via rustup which", async () => {
    mockedIsCommandAvailable.mockImplementation((command) => command === "rustup");
    mockedRunProcess.mockImplementation(async (command, args) => {
      if (command !== "rustup") {
        throw new Error(`Unexpected command: ${command}`);
      }
      if (args[0] === "which") {
        const binaryPath = join(stateDir, "rustup", "rust-analyzer");
        await mkdir(join(stateDir, "rustup"), { recursive: true });
        await writeFile(binaryPath, "", "utf8");
        return {
          stdout: `${binaryPath}\n`,
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        };
      }
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      };
    });

    const status = await getLspToolsStatus(stateDir);

    expect(status.tools.find((tool) => tool.id === "rust-analyzer")).toMatchObject({
      installer: "rustup",
      installed: true,
      binaryPath: join(stateDir, "rustup", "rust-analyzer"),
      version: null,
    });
  });

  it("returns tool status even when a runtime probe fails", async () => {
    mockedIsCommandAvailable.mockImplementation((command) => command === "rustup");
    mockedRunProcess.mockImplementation(async (command) => {
      if (command === "rustup") {
        throw new Error("rustup probe failed");
      }
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      };
    });

    const status = await getLspToolsStatus(stateDir);

    expect(status.tools).toHaveLength(18);
    expect(status.tools.find((tool) => tool.id === "rust-analyzer")).toMatchObject({
      installed: false,
      binaryPath: null,
      version: null,
    });
    expect(status.tools.find((tool) => tool.id === "typescript-language-server")).toMatchObject({
      installed: false,
      binaryPath: null,
      version: null,
    });
  });

  it("rejects installation when npm is unavailable", async () => {
    mockedIsCommandAvailable.mockReturnValue(false);

    await expect(installLspTools(stateDir)).rejects.toThrow(
      "Cannot install language servers because npm is not available in PATH.",
    );
    expect(mockedRunProcess).not.toHaveBeenCalled();
  });

  it("installs tools with npm and returns installed status", async () => {
    mockedIsCommandAvailable.mockImplementation((command) => command === "npm");
    mockedRunProcess.mockImplementation(async (_command, args) => {
      const prefixIndex = args.indexOf("--prefix");
      const installDir = String(args[prefixIndex + 1]);
      await mkdir(join(installDir, "node_modules", ".bin"), { recursive: true });
      await writeFile(commandBinaryPath(stateDir, "typescript-language-server"), "", "utf8");
      await writeFile(commandBinaryPath(stateDir, "vscode-json-language-server"), "", "utf8");
      await writeFile(commandBinaryPath(stateDir, "vscode-css-language-server"), "", "utf8");
      await writeFile(commandBinaryPath(stateDir, "vscode-html-language-server"), "", "utf8");
      await writeFile(commandBinaryPath(stateDir, "vscode-markdown-language-server"), "", "utf8");

      await mkdir(join(installDir, "node_modules", "typescript-language-server"), {
        recursive: true,
      });
      await mkdir(join(installDir, "node_modules", "typescript"), {
        recursive: true,
      });
      await mkdir(join(installDir, "node_modules", "vscode-langservers-extracted"), {
        recursive: true,
      });
      await writeFile(
        join(installDir, "node_modules", "typescript-language-server", "package.json"),
        JSON.stringify({ version: "5.1.3" }),
        "utf8",
      );
      await writeFile(
        join(installDir, "node_modules", "typescript", "package.json"),
        JSON.stringify({ version: "6.0.3" }),
        "utf8",
      );
      await writeFile(
        join(installDir, "node_modules", "vscode-langservers-extracted", "package.json"),
        JSON.stringify({ version: "4.10.0" }),
        "utf8",
      );
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      };
    });

    const installStatus = await installLspTools(stateDir);

    expect(mockedRunProcess).toHaveBeenCalledTimes(1);
    expect(mockedRunProcess).toHaveBeenCalledWith(
      "npm",
      expect.arrayContaining(["install", "--prefix", join(stateDir, "lsp-tools")]),
      expect.objectContaining({
        timeoutMs: 240_000,
        outputMode: "truncate",
      }),
    );
    expect(installStatus.tools.every((tool) => tool.installed || !tool.builtin)).toBe(true);
    expect(
      installStatus.tools.find((tool) => tool.id === "typescript-language-server")?.version,
    ).toBe("5.1.3");
    expect(
      installStatus.tools.find((tool) => tool.id === "vscode-json-language-server")?.version,
    ).toBe("4.10.0");
  });

  it("clears prior install directory when reinstall is requested", async () => {
    mockedIsCommandAvailable.mockReturnValue(true);
    const staleNodeModulesPath = join(stateDir, "lsp-tools", "node_modules", "stale.txt");
    await mkdir(join(stateDir, "lsp-tools", "node_modules"), { recursive: true });
    await writeFile(staleNodeModulesPath, "stale", "utf8");

    mockedRunProcess.mockImplementation(async (_command, args) => {
      const prefixIndex = args.indexOf("--prefix");
      const installDir = String(args[prefixIndex + 1]);
      await mkdir(join(installDir, "node_modules", ".bin"), { recursive: true });
      await writeFile(commandBinaryPath(stateDir, "typescript-language-server"), "", "utf8");
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      };
    });

    await installLspTools(stateDir, { reinstall: true });

    await expect(readFile(staleNodeModulesPath, "utf8")).rejects.toThrow();
  });

  it("installs and persists a custom LSP with file name matching", async () => {
    mockedIsCommandAvailable.mockImplementation((command) => command === "npm");
    mockedRunProcess.mockImplementation(async (_command, args) => {
      const prefixIndex = args.indexOf("--prefix");
      const installDir = String(args[prefixIndex + 1]);
      await mkdir(join(installDir, "node_modules", ".bin"), { recursive: true });
      await writeFile(commandBinaryPath(stateDir, "custom-docker-ls"), "", "utf8");
      await mkdir(join(installDir, "node_modules", "@example", "docker-ls"), { recursive: true });
      await writeFile(
        join(installDir, "node_modules", "@example", "docker-ls", "package.json"),
        JSON.stringify({ version: "1.2.3" }),
        "utf8",
      );
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      };
    });

    const status = await installLspTool(stateDir, {
      packageName: "@example/docker-ls",
      command: "custom-docker-ls",
      label: "Custom Docker",
      description: "Custom Dockerfile language server.",
      installPackages: ["@example/docker-ls@1.2.3"],
      languageIds: ["dockerfile"],
      fileExtensions: [],
      fileNames: ["Dockerfile"],
    });

    expect(status.tools.find((tool) => tool.id === "custom-docker-ls")).toMatchObject({
      label: "Custom Docker",
      source: "custom",
      installed: true,
      version: "1.2.3",
      fileNames: ["dockerfile"],
      installPackages: ["@example/docker-ls@1.2.3"],
    });
  });
});
