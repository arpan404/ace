/**
 * Splits macOS `sample` call graphs of the daemon into native causes the V8 profiler can't
 * separate: SQLite's engine, JSON parse/stringify, GC, compilation, JIT JavaScript and I/O,
 * per thread kind. Idle waits are dropped.
 *
 * node tools/daemon-bench/src/profile/native.ts FILE...
 */
import { readFileSync } from "node:fs";

interface Node {
  count: number;
  symbol: string;
  children: Node[];
  parent: Node | undefined;
}

const idle =
  /^(__psynch_cvwait|kevent|kevent64|semaphore_wait_trap|semaphore_timedwait_trap|mach_msg2_trap|mach_msg_trap|__workq_kernreturn|__select|poll|__ulock_wait2?|__semwait_signal|__sigwait|start_wqthread|thread_start|__wait4)$/;
/** Owners claim a sample from anywhere in its stack, nearest first. */
const owners: [RegExp, string][] = [
  [/^json[A-Z]|^sqlite3Json/, "SQLite JSON functions (json_extract…)"],
  [/sqlite3/, "SQLite engine"],
  [/Json(Parser|Stringifier|Parse|Stringify)|FastJsonStringifier/, "JSON parse/stringify"],
  [
    /Heap::|Scavenger|MarkCompact|MinorMark|Sweeper|ConcurrentMarking|IncrementalMarking|GCTracer|MemoryAllocator|Evacuat|MarkingVisitor|MarkingBarrier|CppHeap|GarbageCollect/,
    "GC",
  ],
  [
    /compiler::|Maglev|Turbofan|Compiler::|Parser::|PreParser|BytecodeGenerator|ScriptCompiler|CompileTask|OptimizingCompile|baseline::/,
    "Compile (parse/JIT)",
  ],
  [/ValueSerializer|ValueDeserializer/, "structuredClone/postMessage (worker messages)"],
  [
    /CaptureSimpleStackTrace|CallSiteBuilder|ErrorUtils|CaptureStackTrace/,
    "Error objects (stack capture)",
  ],
  [/^(uv__fs_|uv_fs_)|node::fs::/, "Filesystem calls"],
  [
    /^(uv__read|uv__write|uv__stream|uv__server|uv_try_write|uv_write)|node::(TCPWrap|StreamBase|LibuvStreamWrap)/,
    "Socket I/O",
  ],
  [/^(uv_spawn|posix_spawn)|node::ProcessWrap/, "Process spawn"],
];
const javascript = /^Builtins_|^\?\?\?$/;
/** Otherwise the leaf decides. */
const leaves: [RegExp, string][] = [
  [/^Builtins_|^\?\?\?$|^v8::internal::Runtime_/, "JavaScript (JIT/builtins)"],
  [/malloc|free|_xzm_|szone|nanov2/, "malloc/free"],
  [/^node::|^v8::/, "V8/Node runtime (property lookup, allocation…)"],
];

const syscall =
  /^(__)?(pread|pwrite|read|write|fsync|fdatasync|fcntl|open|close|stat|fstat|lstat|unlink|ftruncate|mmap|munmap)(\$NOCANCEL)?$/;

function categorize(node: Node): string | undefined {
  if (idle.test(node.symbol)) return undefined;
  if (syscall.test(node.symbol))
    for (let at = node.parent; at && !javascript.test(at.symbol); at = at.parent)
      if (/sqlite3/.test(at.symbol)) return "SQLite file I/O (syscalls)";
  // Owners match only native frames below the nearest JavaScript frame: Node runs promise
  // continuations inside fs and socket callbacks, and that JavaScript is not I/O.
  for (let at: Node | undefined = node; at && !javascript.test(at.symbol); at = at.parent)
    for (const [pattern, name] of owners) if (pattern.test(at.symbol)) return name;
  for (const [pattern, name] of leaves) if (pattern.test(node.symbol)) return name;
  return "other native";
}

function threadKind(header: string): string {
  if (header.includes("com.apple.main-thread")) return "main";
  if (header.includes("node-V8Worker")) return "V8 helpers (GC/compile)";
  if (/libuv-worker|uv_thread|threadpool/i.test(header)) return "libuv threadpool";
  if (/SignalInspector|inspector/i.test(header)) return "inspector";
  if (/DelayedTaskScheduler/.test(header)) return "V8 helpers (GC/compile)";
  return "other threads (workers)";
}

/** With `explain`, the main thread's top native frames inside that category. */
export function nativeSplit(files: readonly string[], explain?: string) {
  const byThread = new Map<string, Map<string, number>>();
  const explained = new Map<string, number>();
  let samples = 0;
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    const start = lines.findIndex((line) => line.startsWith("Call graph:"));
    const stack: { depth: number; node: Node }[] = [];
    let kind = "";
    const roots: { kind: string; node: Node }[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === "" || line.startsWith("Total number")) break;
      const match = /^([\s+!:|]*)(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const depth = (match[1] ?? "").length;
      const text = match[3] ?? "";
      const symbol = (text.split("  (in ")[0] ?? text).trim();
      while (stack.length && (stack.at(-1)?.depth ?? 0) >= depth) stack.pop();
      const parent = stack.at(-1)?.node;
      const node: Node = { count: Number(match[2]), symbol, children: [], parent };
      if (parent) parent.children.push(node);
      else {
        kind = threadKind(symbol);
        roots.push({ kind, node });
      }
      stack.push({ depth, node });
    }
    for (const root of roots) {
      const table = byThread.get(root.kind) ?? new Map<string, number>();
      byThread.set(root.kind, table);
      const visit = (node: Node) => {
        const self = node.count - node.children.reduce((sum, child) => sum + child.count, 0);
        if (self > 0) {
          const category = categorize(node);
          if (category === explain && root.kind === "main") {
            let at: Node | undefined = node;
            while (at && !/^(node::|v8::|uv_)/.test(at.symbol)) at = at.parent;
            const label = `${(at?.symbol ?? node.symbol).slice(0, 90)} | leaf ${node.symbol.slice(0, 50)}`;
            explained.set(label, (explained.get(label) ?? 0) + self);
          }
          if (category) {
            table.set(category, (table.get(category) ?? 0) + self);
            samples += self;
          }
        }
        for (const child of node.children) visit(child);
      };
      visit(root.node);
    }
  }
  const threads = [...byThread].map(([kind, table]) => {
    const total = [...table.values()].reduce((sum, value) => sum + value, 0);
    return {
      kind,
      busySamples: total,
      categories: [...table]
        .toSorted((a, b) => b[1] - a[1])
        .map(([key, value]) => ({
          key,
          samples: value,
          percent: Math.round((value / total) * 1000) / 10,
        })),
    };
  });
  return {
    busySamples: samples,
    threads: threads.toSorted((a, b) => b.busySamples - a.busySamples),
    ...(explain ? { explained: [...explained].toSorted((a, b) => b[1] - a[1]).slice(0, 30) } : {}),
  };
}

if (import.meta.main) {
  const files = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (files.length === 0) throw new Error("Pass sample output files");
  const explain = process.argv.find((arg) => arg.startsWith("--explain="))?.slice(10);
  process.stdout.write(`${JSON.stringify(nativeSplit(files, explain), null, 2)}\n`);
}
