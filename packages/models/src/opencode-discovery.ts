import { connectedOpenCodeProviders } from "./opencode-connections.ts";
import { parseVersion } from "@ace/provider-kit/discovery";
import { z } from "zod";
import { CatalogModel } from "@ace/protocol";
import type { SpawnOptions, SupervisedProcess } from "@ace/provider-kit/process";
import { discoveryError } from "./discovery-errors.ts";
import { discoveryFailureReason } from "@ace/provider-kit/discovery-failure";
import { normalizeOpenCodeReport } from "./opencode-report.ts";
import { base } from "./model.ts";
import type { DiscoveryDiagnostics, DiscoveryReport, ModelInstance } from "./types.ts";

/** v2 metadata is owned and location-scoped; the CLI fallback supplies only IDs. */
export async function discoverOpenCodeCatalog(
  instance: ModelInstance,
  signal: AbortSignal,
  spawn: (options: SpawnOptions) => SupervisedProcess,
  metadata?: (instance: ModelInstance, signal: AbortSignal) => Promise<unknown>,
  diagnostic?: (metadata: DiscoveryDiagnostics) => void,
): Promise<DiscoveryReport> {
  diagnostic?.({ stage: "version" });
  const version = await installedVersion(instance, signal, spawn);
  diagnostic?.({ cliVersion: version });
  diagnostic?.({ stage: "connections" });
  const connected = await connectedOpenCodeProviders(instance, signal, spawn);
  diagnostic?.({ sources: [...connected.values()] });
  if (!connected.size) return { models: [], sources: [] };
  const { discoverOpenCodeModels } = await import("@ace/adapter-opencode");
  diagnostic?.({ stage: "metadata" });
  const payload = metadata
    ? await metadata(instance, signal)
    : await discoverOpenCodeModels(
        {
          discovery: { overrides: { opencode: instance.executable }, env: instance.env },
          runtime: {
            discover: async () => ({
              opencode: {
                installed: true,
                path: instance.executable,
                version,
                auth: "unknown",
                loginHint: "opencode auth login",
              },
              claude: { installed: false, auth: "unknown", loginHint: "" },
              codex: { installed: false, auth: "unknown", loginHint: "" },
              cursor: { installed: false, auth: "unknown", loginHint: "" },
            }),
            spawn: (launch) =>
              spawn({
                ...launch,
                args: [...instance.args, ...(launch.args ?? [])],
                cwd: instance.cwd,
              }),
          },
        },
        instance.cwd,
        signal,
      );
  signal.throwIfAborted();
  let sourceFailures: DiscoveryDiagnostics["sourceFailures"] = [];
  const report = normalizeOpenCodeReport(payload, instance, connected, (details) => {
    sourceFailures = details.sourceFailures ?? sourceFailures;
    diagnostic?.(details);
  });
  if (!report.missingMetadata.length) return report;
  diagnostic?.({ stage: "model-ids" });
  const missingMetadata = new Set(report.missingMetadata);
  const rows: CatalogModel[] = [];
  // Some v2 servers return no model metadata although `models` still lists choices.
  const proc = spawn({
    command: instance.executable,
    args: [...instance.args, "models"],
    cwd: instance.cwd,
    env: instance.env,
    name: "model-discovery",
    maxOutputBytes: 4 * 1024 * 1024,
  });
  const abort = () => {
    void proc.stop({ graceMs: 0 });
  };
  signal.addEventListener("abort", abort, { once: true });
  let failure: unknown;
  const seen = new Set<string>();
  proc.stdout.on("line", (line: string) => {
    if (failure || !line.trim()) return;
    try {
      const id = z
        .string()
        .min(3)
        .max(256)
        .regex(/^[^\s/]+\/\S+$/)
        .parse(line.trim());
      if (!missingMetadata.has(id.slice(0, id.indexOf("/"))) || seen.has(id)) return;
      if (rows.length >= 512 - report.models.length) throw new Error("Too many models");
      const separator = id.indexOf("/");
      rows.push(
        CatalogModel.parse({
          ...base(instance, id, id, { id }),
          nativeProviderId: id.slice(0, separator),
          source: connected.get(id.slice(0, separator)),
        }),
      );
      seen.add(id);
    } catch (error) {
      failure = error;
      abort();
    }
  });
  try {
    if (signal.aborted) abort();
    const exit = await proc.exited;
    signal.throwIfAborted();
    if (failure) throw failure;
    if (exit.reason !== "exit" || exit.code !== 0) throw new Error("OpenCode model listing failed");
    return {
      models: [...report.models, ...rows],
      sources: report.sources.map((status) =>
        rows.some((row) => row.source?.id === status.source.id)
          ? { source: status.source, status: "fresh" }
          : status,
      ),
    };
  } catch (error) {
    signal.throwIfAborted();
    const detail = discoveryError(error, "discovery_failed", instance);
    diagnostic?.({
      sourceFailures: [
        ...(sourceFailures ?? []).filter((entry) => !missingMetadata.has(entry.source)),
        ...(detail.code === "discovery_failed"
          ? [...missingMetadata].map((source) => ({
              source,
              reason: discoveryFailureReason(error, { env: instance.env }),
            }))
          : []),
      ],
    });
    return {
      models: report.models,
      sources: report.sources.map((status) =>
        missingMetadata.has(status.source.id)
          ? { source: status.source, status: "stale", error: detail }
          : status,
      ),
    };
  } finally {
    signal.removeEventListener("abort", abort);
    await proc.stop({ graceMs: 0 });
  }
}

/** A version read avoids probing other providers or touching account APIs. */
async function installedVersion(
  instance: ModelInstance,
  signal: AbortSignal,
  spawn: (options: SpawnOptions) => SupervisedProcess,
): Promise<string> {
  signal.throwIfAborted();
  const proc = spawn({
    command: instance.executable,
    args: [...instance.args, "--version"],
    cwd: instance.cwd,
    env: instance.env,
    name: "opencode-model-version",
    maxOutputBytes: 65536,
  });
  let output = "";
  proc.stdout.on("line", (line: string) => {
    if (output.length < 65536) output += line + "\n";
  });
  const abort = () => {
    void proc.stop({ graceMs: 0 });
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    const exit = await proc.exited;
    signal.throwIfAborted();
    const version = parseVersion("opencode", output);
    if (exit.reason !== "exit" || exit.code !== 0 || !version)
      throw new Error("OpenCode version unavailable");
    return version;
  } finally {
    signal.removeEventListener("abort", abort);
    await proc.stop({ graceMs: 0 });
  }
}
