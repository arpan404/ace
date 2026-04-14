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
import { getLspToolsStatus, installLspTools } from "./lspTools";

const mockedIsCommandAvailable = vi.mocked(isCommandAvailable);
const mockedRunProcess = vi.mocked(runProcess);

let stateDir: string;

function commandBinaryPath(stateDirectory: string, command: string): string {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  return join(stateDirectory, "lsp-tools", "node_modules", ".bin", `${command}${suffix}`);
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

    expect(status.tools).toHaveLength(4);
    for (const tool of status.tools) {
      expect(tool.installed).toBe(false);
      expect(tool.version).toBeNull();
      expect(tool.binaryPath).toBeNull();
    }
  });

  it("rejects installation when npm is unavailable", async () => {
    mockedIsCommandAvailable.mockReturnValue(false);

    await expect(installLspTools(stateDir)).rejects.toThrow(
      "Cannot install language servers because npm is not available in PATH.",
    );
    expect(mockedRunProcess).not.toHaveBeenCalled();
  });

  it("installs tools with npm and returns installed status", async () => {
    mockedIsCommandAvailable.mockReturnValue(true);
    mockedRunProcess.mockImplementation(async (_command, args) => {
      const prefixIndex = args.indexOf("--prefix");
      const installDir = String(args[prefixIndex + 1]);
      await mkdir(join(installDir, "node_modules", ".bin"), { recursive: true });
      await writeFile(commandBinaryPath(stateDir, "typescript-language-server"), "", "utf8");
      await writeFile(commandBinaryPath(stateDir, "vscode-json-language-server"), "", "utf8");
      await writeFile(commandBinaryPath(stateDir, "vscode-css-language-server"), "", "utf8");
      await writeFile(commandBinaryPath(stateDir, "vscode-html-language-server"), "", "utf8");

      await mkdir(join(installDir, "node_modules", "typescript-language-server"), {
        recursive: true,
      });
      await mkdir(join(installDir, "node_modules", "vscode-langservers-extracted"), {
        recursive: true,
      });
      await writeFile(
        join(installDir, "node_modules", "typescript-language-server", "package.json"),
        JSON.stringify({ version: "5.0.1" }),
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
    expect(installStatus.tools.every((tool) => tool.installed)).toBe(true);
    expect(
      installStatus.tools.find((tool) => tool.id === "typescript-language-server")?.version,
    ).toBe("5.0.1");
    expect(
      installStatus.tools.find((tool) => tool.id === "vscode-json-language-server")?.version,
    ).toBe("4.10.0");
  });

  it("clears prior install directory when reinstall is requested", async () => {
    mockedIsCommandAvailable.mockReturnValue(true);
    const stalePath = join(stateDir, "lsp-tools", "stale.txt");
    await mkdir(join(stateDir, "lsp-tools"), { recursive: true });
    await writeFile(stalePath, "stale", "utf8");

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

    await expect(readFile(stalePath, "utf8")).rejects.toThrow();
  });
});
