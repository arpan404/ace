import type { Frame } from "./attribute.ts";

/** Self-time cause of one sample, from its leaf frame and, for natives, its callers. */
export function categorize(stack: readonly Frame[]): string {
  const leaf = stack[0];
  if (!leaf) return "other";
  const { source, name } = leaf;
  if (name === "(garbage collector)") return "GC";
  if (name === "(program)") return "V8/native (program)";
  if (source === "(native)") {
    if (/^(parse|stringify)$/.test(name)) return "JSON parse/stringify";
    // Native leaves (SQLite statements, fs bindings, crypto): charge them to the caller.
    const caller = stack.slice(1).find((frame) => frame.source !== "(native)");
    if (caller && isSqlite(caller)) return "SQLite (native)";
    if (/^(all|get|run|iterate|exec|prepare|columns)$/.test(name)) return "SQLite (native)";
    return `native: ${caller ? jsCategory(caller) : "other"}`;
  }
  return jsCategory(leaf);
}

function isSqlite(frame: Frame) {
  return /sqlite|store-|\/store\.ts|statement/i.test(frame.source);
}

function jsCategory({ source }: Frame): string {
  if (source.includes("node_modules:zod/") || source.startsWith("packages/protocol/"))
    return "Zod validation";
  if (source.includes("node_modules:ws/")) return "WebSocket (ws)";
  if (source.startsWith("node:")) {
    if (/child_process|spawn/.test(source)) return "Node: child processes";
    if (/fs|promises/.test(source)) return "Node: filesystem";
    if (/net|stream|tls|http/.test(source)) return "Node: sockets/streams";
    return "Node: other internals";
  }
  if (source.startsWith("node_modules:")) return `deps: ${source.slice(13).split("/")[0]}`;
  if (/^packages\/adapter-|^packages\/provider-kit/.test(source)) return "Provider decoding";
  if (/^packages\/(projection|core|orchestrator)\//.test(source))
    return "Projection/status (pure core)";
  if (source.startsWith("packages/client/")) return "Client lib (in daemon)";
  if (/^apps\/daemon\/src\/(engine|status)/.test(source)) return "Engine/status (daemon)";
  if (/^apps\/daemon\/src\/.*(store|sqlite|storage|stream-index|write-buffer|wal)/.test(source))
    return "Storage JS (store/serialization)";
  if (
    /^apps\/daemon\/src\/.*(server|socket|delivery|fanout|subscription|wire|session|connection)/.test(
      source,
    )
  )
    return "Server/fan-out JS";
  if (/^apps\/daemon\/src\/.*sidebar/.test(source)) return "Sidebar JS";
  if (source.startsWith("apps/daemon/")) return "Daemon other JS";
  if (source.startsWith("packages/")) return `pkg: ${source.split("/")[1]}`;
  return "other";
}

/** Coarse owner of a frame, for inclusive (frame-on-stack) time. */
export function subsystem({ source, name }: Frame): string | undefined {
  if (source.startsWith("node:internal/modules/"))
    return "module loading (compile + top-level eval)";
  if (source === "(native)" && /^(parse|stringify)$/.test(name)) return "JSON (any caller)";
  if (source.includes("node_modules:zod/")) return "Zod (any caller)";
  if (source.includes("node_modules:ws/")) return "ws library";
  if (/^packages\/adapter-|^packages\/provider-kit/.test(source)) return "Provider adapters";
  if (source.startsWith("packages/projection/")) return "packages/projection";
  if (source.startsWith("packages/core/")) return "packages/core";
  if (source.startsWith("apps/daemon/src/engine/")) return "daemon engine/";
  if (/^apps\/daemon\/src\/.*(store|sqlite|storage)/.test(source)) return "daemon store*";
  if (/^apps\/daemon\/src\/.*sidebar/.test(source)) return "daemon sidebar*";
  if (
    /^apps\/daemon\/src\/.*(server|socket|delivery|fanout|subscription|wire|connection)/.test(
      source,
    )
  )
    return "daemon server/delivery*";
  return undefined;
}
