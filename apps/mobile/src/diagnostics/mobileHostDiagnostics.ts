import { formatErrorMessage } from "../errors";

export interface MobileHostDiagnosticsClient {
  readonly server: {
    readonly getConfig: () => Promise<{ readonly providers: ReadonlyArray<unknown> }>;
    readonly getSettings: () => Promise<unknown>;
    readonly getLspToolsStatus: () => Promise<unknown>;
  };
  readonly orchestration: {
    readonly getSnapshot: () => Promise<{
      readonly projects: ReadonlyArray<{
        readonly id?: string;
        readonly workspaceRoot?: string | null;
      }>;
      readonly threads: ReadonlyArray<{
        readonly id?: string;
      }>;
    }>;
  };
  readonly projects?: {
    readonly listTree: (input: { readonly cwd: string }) => Promise<{
      readonly entries: ReadonlyArray<unknown>;
      readonly truncated: boolean;
    }>;
    readonly createEntry?: (input: {
      readonly cwd: string;
      readonly relativePath: string;
      readonly kind: "file" | "directory";
    }) => Promise<unknown>;
    readonly writeFile?: (input: {
      readonly cwd: string;
      readonly relativePath: string;
      readonly contents: string;
      readonly overwrite?: boolean;
    }) => Promise<unknown>;
    readonly readFile?: (input: {
      readonly cwd: string;
      readonly relativePath: string;
    }) => Promise<{ readonly contents: string }>;
    readonly deleteEntry?: (input: {
      readonly cwd: string;
      readonly relativePath: string;
    }) => Promise<unknown>;
  };
  readonly git?: {
    readonly status: (input: { readonly cwd: string }) => Promise<unknown>;
  };
  readonly terminal?: {
    readonly open: (input: {
      readonly threadId: string;
      readonly cwd: string;
      readonly cols: number;
      readonly rows: number;
      readonly terminalId?: string;
    }) => Promise<unknown>;
    readonly resize: (input: {
      readonly threadId: string;
      readonly cols: number;
      readonly rows: number;
      readonly terminalId?: string;
    }) => Promise<unknown>;
    readonly close: (input: {
      readonly threadId: string;
      readonly terminalId?: string;
      readonly deleteHistory?: boolean;
    }) => Promise<unknown>;
  };
}

export interface MobileHostDiagnosticsTarget {
  readonly hostId: string;
  readonly hostName: string;
  readonly client: MobileHostDiagnosticsClient;
}

export interface MobileHostDiagnosticsStatus {
  readonly hostId: string;
  readonly hostName: string;
  readonly checks: ReadonlyArray<string>;
  readonly error: string | null;
}

const DIAGNOSTICS_FILE_PREFIX = ".ace-mobile-diagnostics-";
const DIAGNOSTICS_TERMINAL_ID = "mobile-diagnostics";

function supportsWorkspaceMutation(projects: MobileHostDiagnosticsClient["projects"]): boolean {
  return Boolean(
    projects?.createEntry && projects.writeFile && projects.readFile && projects.deleteEntry,
  );
}

async function runWorkspaceMutationCheck(
  projects: NonNullable<MobileHostDiagnosticsClient["projects"]>,
  cwd: string,
): Promise<void> {
  if (!supportsWorkspaceMutation(projects)) {
    return;
  }

  const diagnosticsFile = `${DIAGNOSTICS_FILE_PREFIX}${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}.txt`;
  await projects.createEntry?.({
    cwd,
    relativePath: diagnosticsFile,
    kind: "file",
  });
  try {
    const contents = `ace mobile diagnostics\n${new Date().toISOString()}\n`;
    await projects.writeFile?.({
      cwd,
      relativePath: diagnosticsFile,
      contents,
    });
    const readBack = await projects.readFile?.({
      cwd,
      relativePath: diagnosticsFile,
    });
    if (readBack?.contents !== contents) {
      throw new Error("Workspace diagnostic file contents did not round-trip.");
    }
  } finally {
    await projects.deleteEntry?.({
      cwd,
      relativePath: diagnosticsFile,
    });
  }
}

async function runTerminalCheck(
  terminal: NonNullable<MobileHostDiagnosticsClient["terminal"]>,
  threadId: string,
  cwd: string,
): Promise<void> {
  try {
    await terminal.open({
      threadId,
      cwd,
      cols: 80,
      rows: 24,
      terminalId: DIAGNOSTICS_TERMINAL_ID,
    });
    await terminal.resize({
      threadId,
      cols: 100,
      rows: 30,
      terminalId: DIAGNOSTICS_TERMINAL_ID,
    });
  } finally {
    await terminal.close({
      threadId,
      terminalId: DIAGNOSTICS_TERMINAL_ID,
      deleteHistory: true,
    });
  }
}

export async function runMobileHostDiagnostics(
  target: MobileHostDiagnosticsTarget,
): Promise<MobileHostDiagnosticsStatus> {
  const checks: string[] = [];
  try {
    const config = await target.client.server.getConfig();
    checks.push(`${config.providers.length} providers`);
    const snapshot = await target.client.orchestration.getSnapshot();
    checks.push(`${snapshot.projects.length} projects`);
    checks.push(`${snapshot.threads.length} threads`);
    const workspaceRoot = snapshot.projects.find(
      (project) => typeof project.workspaceRoot === "string" && project.workspaceRoot.length > 0,
    )?.workspaceRoot;
    if (workspaceRoot && target.client.projects) {
      const tree = await target.client.projects.listTree({ cwd: workspaceRoot });
      checks.push(`${tree.entries.length}${tree.truncated ? "+" : ""} files`);
      if (supportsWorkspaceMutation(target.client.projects)) {
        await runWorkspaceMutationCheck(target.client.projects, workspaceRoot);
        checks.push("workspace write");
      }
      if (target.client.git) {
        await target.client.git.status({ cwd: workspaceRoot });
        checks.push("git status");
      }
      const threadId = snapshot.threads.find(
        (thread) => typeof thread.id === "string" && thread.id.length > 0,
      )?.id;
      if (threadId && target.client.terminal) {
        await runTerminalCheck(target.client.terminal, threadId, workspaceRoot);
        checks.push("terminal");
      } else {
        checks.push("no terminal thread");
      }
    } else {
      checks.push("no project workspace");
    }
    await target.client.server.getSettings();
    checks.push("settings");
    await target.client.server.getLspToolsStatus();
    checks.push("tooling");
    return {
      hostId: target.hostId,
      hostName: target.hostName,
      checks,
      error: null,
    };
  } catch (cause) {
    return {
      hostId: target.hostId,
      hostName: target.hostName,
      checks,
      error: formatErrorMessage(cause),
    };
  }
}
