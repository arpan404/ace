/**
 * How loaded the machine is, and whether that is heavy enough that a slow daemon is starved
 * rather than hung (ADR 0196). Pure: `pressure-read.ts` gathers the facts.
 */

/** One line of a Linux PSI file (`/proc/pressure/*`): the share of time stalled, in percent. */
export interface PsiLine {
  avg10: number;
  avg60: number;
}
export interface Psi {
  some?: PsiLine | undefined;
  full?: PsiLine | undefined;
}

/** What the OS says about load, as far as each platform tells it. */
export interface SystemPressure {
  cpus: number;
  /** One-minute load average; 0 on Windows, which has none. */
  load1: number;
  /** Linux PSI, when the kernel has it. */
  cpu?: Psi | undefined;
  memory?: Psi | undefined;
  io?: Psi | undefined;
  /** macOS `kern.memorystatus_vm_pressure_level`. */
  memoryLevel?: "normal" | "warn" | "critical" | undefined;
  /** Free physical memory over total, where that number means something (Windows). */
  freeMemory?: number | undefined;
}

export interface PressureVerdict {
  heavy: boolean;
  /** What made it heavy, for the log line. Empty when it is not. */
  reasons: string[];
}

/** Load per CPU above which runnable work waits for a core most of the time. */
const LOAD_PER_CPU = 1.5;
/** PSI avg10 percentages above which the machine is starving its tasks. */
const CPU_SOME = 40;
const MEMORY_SOME = 20;
const MEMORY_FULL = 5;
const IO_FULL = 20;
const FREE_MEMORY = 0.05;

/** A PSI file's text; undefined when it has neither line. Unknown fields are ignored. */
export function parsePsi(text: string): Psi | undefined {
  const psi: Psi = {};
  for (const line of text.split("\n")) {
    const kind = /^(some|full)\s/.exec(line)?.[1];
    if (kind !== "some" && kind !== "full") continue;
    const avg10 = Number(/avg10=([\d.]+)/.exec(line)?.[1]);
    const avg60 = Number(/avg60=([\d.]+)/.exec(line)?.[1]);
    if (!Number.isFinite(avg10) || !Number.isFinite(avg60)) continue;
    psi[kind] = { avg10, avg60 };
  }
  return psi.some || psi.full ? psi : undefined;
}

/** macOS's memory pressure level number (1, 2, 4) as a name. */
export function memoryLevelOf(value: string): SystemPressure["memoryLevel"] {
  const level = Number(value.trim());
  return level === 1 ? "normal" : level === 2 ? "warn" : level === 4 ? "critical" : undefined;
}

/** Whether the machine is loaded enough to starve a process of CPU, memory or I/O. */
export function pressureVerdict(pressure: SystemPressure): PressureVerdict {
  const reasons: string[] = [];
  const perCpu = pressure.load1 / Math.max(1, pressure.cpus);
  if (perCpu >= LOAD_PER_CPU) reasons.push(`load ${pressure.load1} on ${pressure.cpus} CPUs`);
  if ((pressure.cpu?.some?.avg10 ?? 0) >= CPU_SOME)
    reasons.push(`cpu pressure ${pressure.cpu?.some?.avg10}%`);
  if (
    (pressure.memory?.some?.avg10 ?? 0) >= MEMORY_SOME ||
    (pressure.memory?.full?.avg10 ?? 0) >= MEMORY_FULL
  )
    reasons.push(`memory pressure ${pressure.memory?.some?.avg10 ?? 0}%`);
  if ((pressure.io?.full?.avg10 ?? 0) >= IO_FULL)
    reasons.push(`io pressure ${pressure.io?.full?.avg10}%`);
  if (pressure.memoryLevel === "warn" || pressure.memoryLevel === "critical")
    reasons.push(`memory pressure ${pressure.memoryLevel}`);
  if (pressure.freeMemory !== undefined && pressure.freeMemory < FREE_MEMORY)
    reasons.push(`free memory ${Math.round(pressure.freeMemory * 100)}%`);
  return { heavy: reasons.length > 0, reasons };
}

/**
 * A startup or health budget scaled for the machine: as given on a calm machine, `factor` times
 * longer on a heavily loaded one, where the same work takes that much longer to get the CPU.
 */
export function loadAwareBudget(baseMs: number, verdict: PressureVerdict, factor = 4): number {
  return verdict.heavy ? baseMs * factor : baseMs;
}

/** Log fields for a pressure reading. */
export function pressureFields(pressure: SystemPressure): Record<string, unknown> {
  return {
    load1: pressure.load1,
    cpus: pressure.cpus,
    ...(pressure.cpu?.some ? { cpuSome10: pressure.cpu.some.avg10 } : {}),
    ...(pressure.memory?.some ? { memorySome10: pressure.memory.some.avg10 } : {}),
    ...(pressure.memory?.full ? { memoryFull10: pressure.memory.full.avg10 } : {}),
    ...(pressure.io?.full ? { ioFull10: pressure.io.full.avg10 } : {}),
    ...(pressure.memoryLevel ? { memoryLevel: pressure.memoryLevel } : {}),
    ...(pressure.freeMemory === undefined
      ? {}
      : { freeMemory: Math.round(pressure.freeMemory * 1000) / 1000 }),
  };
}
