import { basename, delimiter, dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { Effect, Layer, Ref } from "effect";
import * as Semaphore from "effect/Semaphore";

import type {
  WorkspaceEditorCloseBufferResult,
  WorkspaceEditorCompleteResult,
  WorkspaceEditorDiagnostic,
  WorkspaceEditorCompletionItem,
  WorkspaceEditorSyncBufferResult,
} from "@ace/contracts";

import {
  WorkspaceEditor,
  WorkspaceEditorError,
  type WorkspaceEditorShape,
} from "../Services/WorkspaceEditor";
import { WorkspacePaths } from "../Services/WorkspacePaths";
import { ServerConfig } from "../../config";
import { getLspServerRegistry } from "../../lspTools";

type LspServerId = string;

interface LspServerDefinition {
  readonly args: readonly string[];
  readonly command: string;
  readonly envArgsJsonKey?: string;
  readonly envBinKey?: string;
  readonly id: LspServerId;
  readonly languageIds: ReadonlySet<string>;
  readonly fileExtensions: ReadonlySet<string>;
}

interface LspPendingRequest {
  readonly reject: (error: Error) => void;
  readonly resolve: (value: unknown) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface LspDiagnosticsWaiter {
  readonly minimumRevision: number;
  readonly resolve: (diagnostics: readonly WorkspaceEditorDiagnostic[]) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface LspSession {
  readonly cwd: string;
  readonly diagnosticsByUri: Map<string, readonly WorkspaceEditorDiagnostic[]>;
  readonly diagnosticsRevisionByUri: Map<string, number>;
  readonly diagnosticsWaitersByUri: Map<string, Set<LspDiagnosticsWaiter>>;
  readonly documentVersions: Map<string, number>;
  readonly key: string;
  readonly languageServer: LspServerDefinition;
  readonly mutex: Semaphore.Semaphore;
  readonly openedUris: Set<string>;
  readonly pendingRequests: Map<number, LspPendingRequest>;
  readonly proc: ChildProcessWithoutNullStreams;
  dead: boolean;
  nextRequestId: number;
  stderrTail: string;
  stdoutBuffer: Buffer;
}

const LSP_REQUEST_TIMEOUT_MS = 5_000;
const LSP_SHUTDOWN_TIMEOUT_MS = 750;
const LSP_SYNC_DIAGNOSTICS_TIMEOUT_MS = 550;
const SESSION_RETRY_COOLDOWN_MS = 5_000;
const STDERR_TAIL_MAX_CHARS = 4_000;
const HEADER_BODY_SEPARATOR = Buffer.from("\r\n\r\n");
const PATH_ENV_KEYS = ["PATH", "Path", "path"] as const;
const COMMON_NODE_MODULES_BIN_ANCESTOR_LIMIT = 8;
const DIAGNOSTIC_SOURCE_FALLBACK = "lsp";

const LSP_SERVERS = [
  {
    id: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    languageIds: new Set(["typescript", "typescriptreact", "javascript", "javascriptreact"]),
    fileExtensions: new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]),
    envBinKey: "ACE_LSP_TYPESCRIPT_SERVER_BIN",
    envArgsJsonKey: "ACE_LSP_TYPESCRIPT_SERVER_ARGS_JSON",
  },
  {
    id: "json",
    command: "vscode-json-language-server",
    args: ["--stdio"],
    languageIds: new Set(["json"]),
    fileExtensions: new Set([".json"]),
    envBinKey: "ACE_LSP_JSON_SERVER_BIN",
    envArgsJsonKey: "ACE_LSP_JSON_SERVER_ARGS_JSON",
  },
  {
    id: "css",
    command: "vscode-css-language-server",
    args: ["--stdio"],
    languageIds: new Set(["css", "scss", "less"]),
    fileExtensions: new Set([".css", ".scss", ".less"]),
    envBinKey: "ACE_LSP_CSS_SERVER_BIN",
    envArgsJsonKey: "ACE_LSP_CSS_SERVER_ARGS_JSON",
  },
  {
    id: "html",
    command: "vscode-html-language-server",
    args: ["--stdio"],
    languageIds: new Set(["html"]),
    fileExtensions: new Set([".html", ".htm"]),
    envBinKey: "ACE_LSP_HTML_SERVER_BIN",
    envArgsJsonKey: "ACE_LSP_HTML_SERVER_ARGS_JSON",
  },
] as const satisfies readonly LspServerDefinition[];

const TYPESCRIPT_INFERRED_PROJECT_COMPILER_OPTIONS = {
  allowArbitraryExtensions: true,
  allowImportingTsExtensions: true,
  module: "nodenext",
  moduleResolution: "nodenext",
  resolveJsonModule: true,
  target: "esnext",
  types: ["node", "bun"],
} as const;

const TYPESCRIPT_LANGUAGE_PREFERENCES = {
  includeCompletionsForImportStatements: true,
  includeCompletionsForModuleExports: true,
  includePackageJsonAutoImports: "on",
  preferTypeOnlyAutoImports: true,
  quotePreference: "auto",
} as const;

function toWorkspaceDiagnosticSeverity(severity: unknown): WorkspaceEditorDiagnostic["severity"] {
  if (severity === 2) {
    return "warning";
  }
  if (severity === 3) {
    return "info";
  }
  if (severity === 4) {
    return "hint";
  }
  return "error";
}

function resolveLanguageIdFromPath(relativePath: string): string | null {
  const extension = extname(relativePath).toLowerCase();
  switch (extension) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "typescriptreact";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".jsx":
      return "javascriptreact";
    case ".json":
      return "json";
    case ".css":
      return "css";
    case ".scss":
      return "scss";
    case ".less":
      return "less";
    case ".html":
    case ".htm":
      return "html";
    default:
      return null;
  }
}

function resolveServerForLanguageId(languageId: string): LspServerDefinition | null {
  for (const server of LSP_SERVERS) {
    if (server.languageIds.has(languageId)) {
      return server;
    }
  }
  return null;
}

async function resolveServerForPath(
  stateDir: string,
  relativePath: string,
): Promise<{ readonly languageId: string; readonly server: LspServerDefinition } | null> {
  const builtInLanguageId = resolveLanguageIdFromPath(relativePath);
  if (builtInLanguageId) {
    const builtInServer = resolveServerForLanguageId(builtInLanguageId);
    if (builtInServer) {
      return { languageId: builtInLanguageId, server: builtInServer };
    }
  }
  return resolveCustomServerForPath(stateDir, relativePath);
}

async function resolveCustomServerForPath(
  stateDir: string,
  relativePath: string,
): Promise<{ readonly languageId: string; readonly server: LspServerDefinition } | null> {
  const extension = extname(relativePath).toLowerCase();
  if (extension.length === 0) {
    return null;
  }
  const servers = await getLspServerRegistry(stateDir);
  for (const server of servers) {
    if (server.builtin || !server.fileExtensions.has(extension)) {
      continue;
    }
    const languageId = server.languageIds.values().next().value;
    if (typeof languageId !== "string" || languageId.length === 0) {
      continue;
    }
    return {
      languageId,
      server: {
        id: server.id,
        command: server.command,
        args: server.args,
        languageIds: server.languageIds,
        fileExtensions: server.fileExtensions,
      },
    };
  }
  return null;
}

function parseServerArgsOverride(raw: string | undefined): readonly string[] | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function appendStderrTail(session: LspSession, chunk: Buffer | string): void {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  session.stderrTail = `${session.stderrTail}${text}`.slice(-STDERR_TAIL_MAX_CHARS);
}

function resolvePathEnvValue(env: NodeJS.ProcessEnv): string {
  for (const key of PATH_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

function collectNodeModuleBinDirectories(anchors: readonly string[]): readonly string[] {
  const directories = new Set<string>();
  for (const anchor of anchors) {
    let current = anchor;
    for (let index = 0; index < COMMON_NODE_MODULES_BIN_ANCESTOR_LIMIT; index += 1) {
      const candidate = join(current, "node_modules", ".bin");
      if (existsSync(candidate)) {
        directories.add(candidate);
      }
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return [...directories];
}

function buildLspEnvironment(stateDir: string): NodeJS.ProcessEnv {
  const nextEnv = { ...process.env };
  const currentPath = resolvePathEnvValue(nextEnv);
  const localBins = collectNodeModuleBinDirectories([
    process.cwd(),
    import.meta.dirname,
    join(stateDir, "lsp-tools"),
  ]);
  const nextPathEntries = [...localBins, ...currentPath.split(delimiter).filter(Boolean)];
  if (nextPathEntries.length > 0) {
    nextEnv.PATH = Array.from(new Set(nextPathEntries)).join(delimiter);
  }
  const nodeModulesDirs = collectNodeModuleBinDirectories([
    join(stateDir, "lsp-tools"),
    process.cwd(),
  ]);
  if (nodeModulesDirs.length > 0) {
    const currentNodePath = nextEnv.NODE_PATH ?? nextEnv.NodePath ?? "";
    const nodePathEntries = [
      ...nodeModulesDirs,
      ...currentNodePath.split(delimiter).filter(Boolean),
    ];
    nextEnv.NODE_PATH = Array.from(new Set(nodePathEntries)).join(delimiter);
  }
  return nextEnv;
}

function parseLspDiagnostics(
  payload: unknown,
  sourceFallback: string,
): readonly WorkspaceEditorDiagnostic[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }
  const diagnostics = Reflect.get(payload, "diagnostics");
  if (!Array.isArray(diagnostics)) {
    return [];
  }
  return diagnostics.flatMap((item): WorkspaceEditorDiagnostic[] => {
    if (typeof item !== "object" || item === null) {
      return [];
    }
    const message = Reflect.get(item, "message");
    const range = Reflect.get(item, "range");
    const code = Reflect.get(item, "code");
    const source = Reflect.get(item, "source");
    const severity = Reflect.get(item, "severity");
    if (typeof message !== "string" || typeof range !== "object" || range === null) {
      return [];
    }
    const start = Reflect.get(range, "start");
    const end = Reflect.get(range, "end");
    if (typeof start !== "object" || start === null || typeof end !== "object" || end === null) {
      return [];
    }

    const startLine = Number(Reflect.get(start, "line"));
    const startColumn = Number(Reflect.get(start, "character"));
    const endLine = Number(Reflect.get(end, "line"));
    const endColumn = Number(Reflect.get(end, "character"));
    if (
      !Number.isFinite(startLine) ||
      !Number.isFinite(startColumn) ||
      !Number.isFinite(endLine) ||
      !Number.isFinite(endColumn)
    ) {
      return [];
    }

    return [
      {
        code: typeof code === "string" || typeof code === "number" ? String(code) : undefined,
        endColumn: Math.max(Math.trunc(endColumn), Math.trunc(startColumn) + 1),
        endLine: Math.max(Math.trunc(endLine), Math.trunc(startLine)),
        message,
        severity: toWorkspaceDiagnosticSeverity(severity),
        source: typeof source === "string" && source.trim().length > 0 ? source : sourceFallback,
        startColumn: Math.max(0, Math.trunc(startColumn)),
        startLine: Math.max(0, Math.trunc(startLine)),
      },
    ];
  });
}

function parseCompletionDocumentation(documentation: unknown): string | undefined {
  if (typeof documentation === "string") {
    return documentation;
  }
  if (typeof documentation !== "object" || documentation === null) {
    return undefined;
  }
  const value = Reflect.get(documentation, "value");
  return typeof value === "string" ? value : undefined;
}

function parseLspCompletionItems(payload: unknown): readonly WorkspaceEditorCompletionItem[] {
  const rawItems = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null
      ? Reflect.get(payload, "items")
      : undefined;
  if (!Array.isArray(rawItems)) {
    return [];
  }
  return rawItems.flatMap((item): WorkspaceEditorCompletionItem[] => {
    if (typeof item !== "object" || item === null) {
      return [];
    }
    const label = Reflect.get(item, "label");
    if (typeof label !== "string" || label.trim().length === 0) {
      return [];
    }
    const kind = Reflect.get(item, "kind");
    const detail = Reflect.get(item, "detail");
    const insertText = Reflect.get(item, "insertText");
    const sortText = Reflect.get(item, "sortText");
    const filterText = Reflect.get(item, "filterText");
    return [
      {
        label,
        kind: typeof kind === "number" || typeof kind === "string" ? String(kind) : undefined,
        detail: typeof detail === "string" ? detail : undefined,
        documentation: parseCompletionDocumentation(Reflect.get(item, "documentation")),
        insertText: typeof insertText === "string" ? insertText : undefined,
        sortText: typeof sortText === "string" && sortText.trim().length > 0 ? sortText : undefined,
        filterText:
          typeof filterText === "string" && filterText.trim().length > 0 ? filterText : undefined,
      },
    ];
  });
}

function isResponseMessage(message: unknown): message is {
  readonly id: number | string;
  readonly result?: unknown;
  readonly error?: { readonly message?: unknown };
} {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const id = Reflect.get(message, "id");
  if (typeof id !== "number" && typeof id !== "string") {
    return false;
  }
  const method = Reflect.get(message, "method");
  if (typeof method === "string") {
    return false;
  }
  return Reflect.has(message, "result") || Reflect.has(message, "error");
}

function isRequestMessage(message: unknown): message is {
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
} {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const method = Reflect.get(message, "method");
  if (typeof method !== "string") {
    return false;
  }
  const id = Reflect.get(message, "id");
  return typeof id === "number" || typeof id === "string";
}

function resolveWorkspaceConfigurationValue(
  languageServerId: LspServerId,
  section: string | null,
): unknown {
  if (languageServerId !== "typescript" || !section) {
    return null;
  }
  switch (section) {
    case "typescript":
    case "javascript":
      return {
        preferences: TYPESCRIPT_LANGUAGE_PREFERENCES,
      };
    case "typescript.preferences":
    case "javascript.preferences":
      return TYPESCRIPT_LANGUAGE_PREFERENCES;
    default:
      return null;
  }
}

async function sendLspResponse(
  session: LspSession,
  id: number | string,
  payload:
    | { readonly result: unknown }
    | { readonly error: { readonly code: number; readonly message: string } },
): Promise<void> {
  if (session.dead) {
    return;
  }
  await writeLspPacket(session, {
    jsonrpc: "2.0",
    id,
    ...payload,
  });
}

async function handleServerRequest(
  session: LspSession,
  method: string,
  id: number | string,
  params: unknown,
): Promise<void> {
  switch (method) {
    case "workspace/configuration": {
      const items =
        typeof params === "object" && params !== null ? Reflect.get(params, "items") : undefined;
      const result = Array.isArray(items)
        ? items.map((item) => {
            const section =
              typeof item === "object" && item !== null ? Reflect.get(item, "section") : undefined;
            return resolveWorkspaceConfigurationValue(
              session.languageServer.id,
              typeof section === "string" ? section : null,
            );
          })
        : [];
      await sendLspResponse(session, id, { result });
      return;
    }
    case "workspace/workspaceFolders": {
      await sendLspResponse(session, id, {
        result: [{ name: basename(session.cwd), uri: pathToFileURL(session.cwd).toString() }],
      });
      return;
    }
    case "window/workDoneProgress/create":
    case "client/registerCapability":
    case "client/unregisterCapability":
      await sendLspResponse(session, id, { result: null });
      return;
    default:
      await sendLspResponse(session, id, {
        error: {
          code: -32601,
          message: `Method not found: ${method}`,
        },
      });
  }
}

function handleServerNotification(session: LspSession, method: string, params: unknown): void {
  if (method === "window/logMessage") {
    const message =
      typeof params === "object" && params !== null ? Reflect.get(params, "message") : undefined;
    if (typeof message === "string" && message.trim().length > 0) {
      appendStderrTail(session, `${message}\n`);
    }
  }
}

function parseContentLength(headerBlock: string): number | null {
  const lines = headerBlock.split("\r\n");
  for (const line of lines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    if (key !== "content-length") {
      continue;
    }
    const rawLength = line.slice(separatorIndex + 1).trim();
    const length = Number(rawLength);
    if (!Number.isFinite(length) || length < 0) {
      return null;
    }
    return Math.trunc(length);
  }
  return null;
}

function failPendingRequests(session: LspSession, error: Error): void {
  for (const pending of session.pendingRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(error);
  }
  session.pendingRequests.clear();
}

function resolveDiagnosticsWaiters(
  session: LspSession,
  uri: string,
  diagnostics: readonly WorkspaceEditorDiagnostic[],
): void {
  const waiters = session.diagnosticsWaitersByUri.get(uri);
  if (!waiters || waiters.size === 0) {
    return;
  }
  const revision = session.diagnosticsRevisionByUri.get(uri) ?? 0;
  for (const waiter of waiters) {
    if (waiter.minimumRevision >= revision) {
      continue;
    }
    waiters.delete(waiter);
    clearTimeout(waiter.timeout);
    waiter.resolve(diagnostics);
  }
  if (waiters.size === 0) {
    session.diagnosticsWaitersByUri.delete(uri);
  }
}

function readAvailableLspMessages(
  session: LspSession,
  onMessage: (message: unknown) => void,
): void {
  while (true) {
    const headerEndIndex = session.stdoutBuffer.indexOf(HEADER_BODY_SEPARATOR);
    if (headerEndIndex < 0) {
      return;
    }
    const headerBlock = session.stdoutBuffer.subarray(0, headerEndIndex).toString("utf8");
    const contentLength = parseContentLength(headerBlock);
    if (contentLength === null) {
      session.stdoutBuffer = Buffer.alloc(0);
      return;
    }

    const bodyStart = headerEndIndex + HEADER_BODY_SEPARATOR.length;
    const bodyEnd = bodyStart + contentLength;
    if (session.stdoutBuffer.length < bodyEnd) {
      return;
    }

    const rawBody = session.stdoutBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
    session.stdoutBuffer = session.stdoutBuffer.subarray(bodyEnd);
    try {
      onMessage(JSON.parse(rawBody));
    } catch {
      // Ignore malformed payloads from crashed server output.
    }
  }
}

async function writeLspPacket(session: LspSession, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const packet = `Content-Length: ${String(Buffer.byteLength(body, "utf8"))}\r\n\r\n${body}`;
  await new Promise<void>((resolve, reject) => {
    session.proc.stdin.write(packet, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function sendLspNotification(
  session: LspSession,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  if (session.dead) {
    throw new Error("LSP session is not running.");
  }
  await writeLspPacket(session, {
    jsonrpc: "2.0",
    method,
    params,
  });
}

async function sendLspRequest(
  session: LspSession,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  if (session.dead) {
    throw new Error("LSP session is not running.");
  }
  const requestId = session.nextRequestId;
  session.nextRequestId += 1;

  const responsePromise = new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      session.pendingRequests.delete(requestId);
      reject(new Error(`LSP request timed out: ${method}`));
    }, timeoutMs);
    session.pendingRequests.set(requestId, {
      reject,
      resolve,
      timeout,
    });
  });

  try {
    await writeLspPacket(session, {
      jsonrpc: "2.0",
      id: requestId,
      method,
      params,
    });
  } catch (error) {
    const pending = session.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      session.pendingRequests.delete(requestId);
    }
    throw error;
  }

  return responsePromise;
}

function waitForDiagnosticsUpdate(
  session: LspSession,
  uri: string,
  timeoutMs: number,
): Promise<readonly WorkspaceEditorDiagnostic[]> {
  const previousRevision = session.diagnosticsRevisionByUri.get(uri) ?? 0;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      const waiters = session.diagnosticsWaitersByUri.get(uri);
      if (waiters) {
        for (const waiter of waiters) {
          if (waiter.timeout === timeout) {
            waiters.delete(waiter);
          }
        }
        if (waiters.size === 0) {
          session.diagnosticsWaitersByUri.delete(uri);
        }
      }
      resolve(session.diagnosticsByUri.get(uri) ?? []);
    }, timeoutMs);

    const waiter: LspDiagnosticsWaiter = {
      minimumRevision: previousRevision,
      timeout,
      resolve,
    };
    const waiters = session.diagnosticsWaitersByUri.get(uri);
    if (waiters) {
      waiters.add(waiter);
    } else {
      session.diagnosticsWaitersByUri.set(uri, new Set([waiter]));
    }
  });
}

async function syncSessionDocument(
  session: LspSession,
  uri: string,
  languageId: string,
  contents: string,
): Promise<readonly WorkspaceEditorDiagnostic[]> {
  const diagnosticsPromise = waitForDiagnosticsUpdate(
    session,
    uri,
    LSP_SYNC_DIAGNOSTICS_TIMEOUT_MS,
  );
  const nextVersion = (session.documentVersions.get(uri) ?? 0) + 1;
  if (session.openedUris.has(uri)) {
    await sendLspNotification(session, "textDocument/didChange", {
      textDocument: { uri, version: nextVersion },
      contentChanges: [{ text: contents }],
    });
  } else {
    await sendLspNotification(session, "textDocument/didOpen", {
      textDocument: {
        uri,
        languageId,
        version: nextVersion,
        text: contents,
      },
    });
    session.openedUris.add(uri);
  }
  session.documentVersions.set(uri, nextVersion);
  return diagnosticsPromise;
}

async function waitForProcessSpawn(proc: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      proc.off("spawn", onSpawn);
      proc.off("error", onError);
    };
    proc.once("spawn", onSpawn);
    proc.once("error", onError);
  });
}

async function waitForProcessExit(
  proc: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (proc.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    let timeout: ReturnType<typeof setTimeout>;
    const onExit = () => done();
    const onError = () => done();
    const done = () => {
      clearTimeout(timeout);
      proc.off("exit", onExit);
      proc.off("error", onError);
      resolve();
    };
    timeout = setTimeout(done, timeoutMs);
    proc.once("exit", onExit);
    proc.once("error", onError);
  });
}

function resolveServerCommand(definition: LspServerDefinition): {
  readonly args: readonly string[];
  readonly command: string;
} {
  const commandOverride = definition.envBinKey
    ? process.env[definition.envBinKey]?.trim()
    : undefined;
  const argsOverride = definition.envArgsJsonKey
    ? parseServerArgsOverride(process.env[definition.envArgsJsonKey])
    : null;
  return {
    command: commandOverride && commandOverride.length > 0 ? commandOverride : definition.command,
    args: argsOverride ?? definition.args,
  };
}

function createSessionKey(cwd: string, serverId: LspServerId): string {
  return `${cwd}:${serverId}`;
}

function handleServerMessage(session: LspSession, message: unknown): void {
  if (isResponseMessage(message)) {
    if (typeof message.id !== "number") {
      return;
    }
    const pending = session.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }
    session.pendingRequests.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) {
      const rawMessage = message.error.message;
      pending.reject(
        new Error(typeof rawMessage === "string" ? rawMessage : "LSP request failed."),
      );
      return;
    }
    pending.resolve(message.result);
    return;
  }

  if (typeof message !== "object" || message === null) {
    return;
  }
  if (isRequestMessage(message)) {
    void handleServerRequest(session, message.method, message.id, message.params).catch((error) => {
      appendStderrTail(
        session,
        `Failed to handle LSP server request (${message.method}): ${String(error)}\n`,
      );
    });
    return;
  }
  const method = Reflect.get(message, "method");
  if (typeof method !== "string") {
    return;
  }
  const params = Reflect.get(message, "params");
  if (method !== "textDocument/publishDiagnostics") {
    handleServerNotification(session, method, params);
    return;
  }
  if (typeof params !== "object" || params === null) {
    return;
  }
  const uri = Reflect.get(params, "uri");
  if (typeof uri !== "string" || uri.length === 0) {
    return;
  }
  const diagnostics = parseLspDiagnostics(params, DIAGNOSTIC_SOURCE_FALLBACK);
  const nextRevision = (session.diagnosticsRevisionByUri.get(uri) ?? 0) + 1;
  session.diagnosticsByUri.set(uri, diagnostics);
  session.diagnosticsRevisionByUri.set(uri, nextRevision);
  resolveDiagnosticsWaiters(session, uri, diagnostics);
}

async function closeSession(session: LspSession): Promise<void> {
  session.dead = true;
  failPendingRequests(session, new Error("LSP session closed."));
  for (const waiters of session.diagnosticsWaitersByUri.values()) {
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve([]);
    }
  }
  session.diagnosticsWaitersByUri.clear();

  try {
    await sendLspRequest(session, "shutdown", {}, LSP_SHUTDOWN_TIMEOUT_MS);
  } catch {
    // Best effort shutdown.
  }
  try {
    await sendLspNotification(session, "exit", {});
  } catch {
    // Best effort shutdown.
  }
  if (session.proc.exitCode === null && !session.proc.killed) {
    session.proc.kill("SIGTERM");
    await waitForProcessExit(session.proc, 500);
  }
  if (session.proc.exitCode === null && !session.proc.killed) {
    session.proc.kill("SIGKILL");
    await waitForProcessExit(session.proc, 250);
  }
}

export const makeWorkspaceEditor = Effect.gen(function* () {
  const workspacePaths = yield* WorkspacePaths;
  const serverConfig = yield* ServerConfig;
  const sessionsRef = yield* Ref.make(new Map<string, LspSession>());
  const sessionRetryAtRef = yield* Ref.make(new Map<string, number>());

  yield* Effect.addFinalizer(() =>
    Ref.get(sessionsRef).pipe(
      Effect.flatMap((sessions) =>
        Effect.forEach(
          [...sessions.values()],
          (session) => Effect.promise(() => closeSession(session)),
          {
            concurrency: "unbounded",
            discard: true,
          },
        ),
      ),
      Effect.ignore({ log: true }),
    ),
  );

  const createSession = Effect.fn("WorkspaceEditor.createSession")(function* (
    cwd: string,
    languageServer: LspServerDefinition,
  ): Effect.fn.Return<LspSession, WorkspaceEditorError> {
    const { command, args } = resolveServerCommand(languageServer);
    const env = buildLspEnvironment(serverConfig.stateDir);

    yield* Effect.logDebug(
      `[WorkspaceEditor] Creating LSP session for ${languageServer.id} in ${cwd}`,
    );
    yield* Effect.logDebug(`[WorkspaceEditor] Command: ${command}, Args: ${JSON.stringify(args)}`);
    yield* Effect.logDebug(`[WorkspaceEditor] PATH: ${env.PATH?.slice(0, 200)}...`);

    const proc = spawn(command, [...args], {
      cwd,
      env,
      stdio: "pipe",
    });

    yield* Effect.tryPromise({
      try: () => waitForProcessSpawn(proc),
      catch: (cause) =>
        new WorkspaceEditorError({
          cause,
          cwd,
          detail: `Workspace diagnostics backend unavailable: unable to spawn ${languageServer.id} language server (${command}).`,
          operation: "workspaceEditor.spawnLspServer",
        }),
    });

    yield* Effect.logDebug(`[WorkspaceEditor] Spawn succeeded for ${languageServer.id}`);

    const session: LspSession = {
      cwd,
      dead: false,
      diagnosticsByUri: new Map(),
      diagnosticsRevisionByUri: new Map(),
      diagnosticsWaitersByUri: new Map(),
      documentVersions: new Map(),
      key: createSessionKey(cwd, languageServer.id),
      languageServer,
      mutex: yield* Semaphore.make(1),
      nextRequestId: 1,
      openedUris: new Set(),
      pendingRequests: new Map(),
      proc,
      stderrTail: "",
      stdoutBuffer: Buffer.alloc(0),
    };

    proc.stdout.on("data", (chunk: Buffer | string) => {
      if (session.dead) {
        return;
      }
      const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      session.stdoutBuffer = Buffer.concat([session.stdoutBuffer, data]);
      readAvailableLspMessages(session, (message) => handleServerMessage(session, message));
    });
    proc.stderr.on("data", (chunk: Buffer | string) => {
      appendStderrTail(session, chunk);
    });
    proc.once("exit", () => {
      session.dead = true;
      failPendingRequests(session, new Error("Language server exited unexpectedly."));
    });
    proc.once("error", () => {
      session.dead = true;
      failPendingRequests(session, new Error("Language server process errored."));
    });

    const rootUri = pathToFileURL(cwd).toString();
    yield* Effect.tryPromise({
      try: () =>
        sendLspRequest(
          session,
          "initialize",
          {
            capabilities: {
              textDocument: {
                publishDiagnostics: {},
                synchronization: {
                  didClose: true,
                  didSave: false,
                  dynamicRegistration: false,
                  willSave: false,
                  willSaveWaitUntil: false,
                },
              },
              workspace: {},
            },
            clientInfo: { name: "ace" },
            initializationOptions:
              languageServer.id === "typescript"
                ? {
                    hostInfo: "ace",
                    preferences: {
                      includePackageJsonAutoImports: "on",
                    },
                  }
                : undefined,
            processId: process.pid,
            rootPath: cwd,
            rootUri,
            workspaceFolders: [{ name: basename(cwd), uri: rootUri }],
          },
          LSP_REQUEST_TIMEOUT_MS,
        )
          .then(() => sendLspNotification(session, "initialized", {}))
          .then(async () => {
            if (languageServer.id !== "typescript") {
              return;
            }
            await sendLspRequest(
              session,
              "workspace/executeCommand",
              {
                command: "typescript.tsserverRequest",
                arguments: [
                  "compilerOptionsForInferredProjects",
                  {
                    options: TYPESCRIPT_INFERRED_PROJECT_COMPILER_OPTIONS,
                  },
                ],
              },
              LSP_REQUEST_TIMEOUT_MS,
            ).catch(() => undefined);
          }),
      catch: (cause) =>
        new WorkspaceEditorError({
          cause,
          cwd,
          detail: `Workspace diagnostics backend unavailable: failed to initialize ${languageServer.id} language server.${session.stderrTail.trim().length > 0 ? ` ${session.stderrTail.trim()}` : ""}`,
          operation: "workspaceEditor.initializeLspServer",
        }),
    });

    yield* Effect.logDebug(`[WorkspaceEditor] Initialize completed for ${languageServer.id}`);

    return session;
  });

  const getOrCreateSession = Effect.fn("WorkspaceEditor.getOrCreateSession")(function* (
    cwd: string,
    languageServer: LspServerDefinition,
  ): Effect.fn.Return<LspSession, WorkspaceEditorError> {
    const key = createSessionKey(cwd, languageServer.id);
    const existing = (yield* Ref.get(sessionsRef)).get(key);
    if (existing && !existing.dead && existing.proc.exitCode === null) {
      return existing;
    }

    if (existing) {
      yield* Effect.promise(() => closeSession(existing)).pipe(Effect.ignore({ log: true }));
      yield* Ref.update(sessionsRef, (sessions) => {
        const next = new Map(sessions);
        next.delete(key);
        return next;
      });
    }

    const retryAt = (yield* Ref.get(sessionRetryAtRef)).get(key) ?? 0;
    if (retryAt > Date.now()) {
      return yield* new WorkspaceEditorError({
        cwd,
        detail:
          "Workspace diagnostics backend unavailable: language server restart is cooling down after a previous failure.",
        operation: "workspaceEditor.cooldown",
      });
    }

    const created = yield* createSession(cwd, languageServer).pipe(
      Effect.tapError(() =>
        Ref.update(sessionRetryAtRef, (entries) => {
          const next = new Map(entries);
          next.set(key, Date.now() + SESSION_RETRY_COOLDOWN_MS);
          return next;
        }),
      ),
    );
    yield* Ref.update(sessionRetryAtRef, (entries) => {
      const next = new Map(entries);
      next.delete(key);
      return next;
    });
    yield* Ref.update(sessionsRef, (sessions) => {
      const next = new Map(sessions);
      next.set(key, created);
      return next;
    });
    return created;
  });

  const syncBuffer: WorkspaceEditorShape["syncBuffer"] = Effect.fn("WorkspaceEditor.syncBuffer")(
    function* (input) {
      yield* Effect.logDebug(`[WorkspaceEditor] syncBuffer: ${input.relativePath} in ${input.cwd}`);

      const normalizedWorkspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd);
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: normalizedWorkspaceRoot,
        relativePath: input.relativePath,
      });
      const resolved = yield* Effect.tryPromise({
        try: () => resolveServerForPath(serverConfig.stateDir, target.relativePath),
        catch: (cause) =>
          new WorkspaceEditorError({
            cause,
            cwd: normalizedWorkspaceRoot,
            detail: "Failed to resolve language server for workspace buffer.",
            operation: "workspaceEditor.syncBuffer",
            relativePath: target.relativePath,
          }),
      });
      if (!resolved) {
        yield* Effect.logDebug(`[WorkspaceEditor] No languageId for ${target.relativePath}`);
        return {
          diagnostics: [],
          relativePath: target.relativePath,
        } satisfies WorkspaceEditorSyncBufferResult;
      }
      const { languageId, server: languageServer } = resolved;

      yield* Effect.logDebug(`[WorkspaceEditor] Using LSP server: ${languageServer.id}`);
      const session = yield* getOrCreateSession(normalizedWorkspaceRoot, languageServer);
      const uri = pathToFileURL(target.absolutePath).toString();
      const diagnostics = yield* session.mutex.withPermits(1)(
        Effect.tryPromise({
          try: async () => {
            return syncSessionDocument(session, uri, languageId, input.contents);
          },
          catch: (cause) =>
            new WorkspaceEditorError({
              cause,
              cwd: normalizedWorkspaceRoot,
              detail: `Workspace diagnostics backend unavailable: failed to sync LSP buffer.${session.stderrTail.trim().length > 0 ? ` ${session.stderrTail.trim()}` : ""}`,
              operation: "workspaceEditor.syncBuffer",
              relativePath: target.relativePath,
            }),
        }),
      );

      return {
        diagnostics,
        relativePath: target.relativePath,
      } satisfies WorkspaceEditorSyncBufferResult;
    },
  );

  const closeBuffer: WorkspaceEditorShape["closeBuffer"] = Effect.fn("WorkspaceEditor.closeBuffer")(
    function* (input) {
      yield* Effect.logDebug(`[WorkspaceEditor] closeBuffer: ${input.relativePath}`);
      const normalizedWorkspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd);
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: normalizedWorkspaceRoot,
        relativePath: input.relativePath,
      });
      const resolved = yield* Effect.tryPromise({
        try: () => resolveServerForPath(serverConfig.stateDir, target.relativePath),
        catch: (cause) =>
          new WorkspaceEditorError({
            cause,
            cwd: normalizedWorkspaceRoot,
            detail: "Failed to resolve language server for workspace buffer.",
            operation: "workspaceEditor.closeBuffer",
            relativePath: target.relativePath,
          }),
      });
      if (!resolved) {
        return {
          relativePath: target.relativePath,
        } satisfies WorkspaceEditorCloseBufferResult;
      }
      const languageServer = resolved.server;
      const key = createSessionKey(normalizedWorkspaceRoot, languageServer.id);
      const existing = (yield* Ref.get(sessionsRef)).get(key);
      if (!existing || existing.dead || existing.proc.exitCode !== null) {
        return {
          relativePath: target.relativePath,
        } satisfies WorkspaceEditorCloseBufferResult;
      }

      const uri = pathToFileURL(target.absolutePath).toString();
      yield* existing.mutex.withPermits(1)(
        Effect.tryPromise({
          try: async () => {
            if (!existing.openedUris.has(uri)) {
              existing.documentVersions.delete(uri);
              existing.diagnosticsByUri.delete(uri);
              existing.diagnosticsRevisionByUri.delete(uri);
              return;
            }
            await sendLspNotification(existing, "textDocument/didClose", {
              textDocument: { uri },
            });
            existing.openedUris.delete(uri);
            existing.documentVersions.delete(uri);
            existing.diagnosticsByUri.delete(uri);
            existing.diagnosticsRevisionByUri.delete(uri);
          },
          catch: (cause) =>
            new WorkspaceEditorError({
              cause,
              cwd: normalizedWorkspaceRoot,
              detail: "Failed to close the workspace diagnostics buffer.",
              operation: "workspaceEditor.closeBuffer",
              relativePath: target.relativePath,
            }),
        }),
      );

      return {
        relativePath: target.relativePath,
      } satisfies WorkspaceEditorCloseBufferResult;
    },
  );

  const complete: WorkspaceEditorShape["complete"] = Effect.fn("WorkspaceEditor.complete")(
    function* (input) {
      const normalizedWorkspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd);
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: normalizedWorkspaceRoot,
        relativePath: input.relativePath,
      });
      const resolved = yield* Effect.tryPromise({
        try: () => resolveServerForPath(serverConfig.stateDir, target.relativePath),
        catch: (cause) =>
          new WorkspaceEditorError({
            cause,
            cwd: normalizedWorkspaceRoot,
            detail: "Failed to resolve language server for completions.",
            operation: "workspaceEditor.complete",
            relativePath: target.relativePath,
          }),
      });
      if (!resolved) {
        return {
          relativePath: target.relativePath,
          items: [],
        } satisfies WorkspaceEditorCompleteResult;
      }
      const { languageId, server: languageServer } = resolved;
      const session = yield* getOrCreateSession(normalizedWorkspaceRoot, languageServer);
      const uri = pathToFileURL(target.absolutePath).toString();
      const items = yield* session.mutex.withPermits(1)(
        Effect.tryPromise({
          try: async () => {
            await syncSessionDocument(session, uri, languageId, input.contents);
            const result = await sendLspRequest(
              session,
              "textDocument/completion",
              {
                textDocument: { uri },
                position: { line: input.line, character: input.column },
              },
              LSP_REQUEST_TIMEOUT_MS,
            );
            return parseLspCompletionItems(result);
          },
          catch: (cause) =>
            new WorkspaceEditorError({
              cause,
              cwd: normalizedWorkspaceRoot,
              detail: `Workspace completion backend unavailable.${session.stderrTail.trim().length > 0 ? ` ${session.stderrTail.trim()}` : ""}`,
              operation: "workspaceEditor.complete",
              relativePath: target.relativePath,
            }),
        }),
      );
      return {
        relativePath: target.relativePath,
        items,
      } satisfies WorkspaceEditorCompleteResult;
    },
  );

  return {
    closeBuffer,
    complete,
    syncBuffer,
  } satisfies WorkspaceEditorShape;
});

export const WorkspaceEditorLive = Layer.effect(WorkspaceEditor, makeWorkspaceEditor);
