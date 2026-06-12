const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);

const BYTE_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1024,
  k: 1024,
  mb: 1024 * 1024,
  m: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  g: 1024 * 1024 * 1024,
};

export function readPositiveIntegerEnv(input: {
  readonly envVarName: string;
  readonly fallback: number;
  readonly minimum?: number;
  readonly maximum?: number;
}): number {
  const minimum = input.minimum ?? 1;
  const raw = process.env[input.envVarName];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  const value = Number.isFinite(parsed) ? parsed : input.fallback;
  const boundedMinimum = Math.max(minimum, value);
  return input.maximum === undefined ? boundedMinimum : Math.min(input.maximum, boundedMinimum);
}

export function readBooleanEnv(input: {
  readonly envVarName: string;
  readonly fallback: boolean;
}): boolean {
  const raw = process.env[input.envVarName]?.trim().toLowerCase();
  if (!raw) {
    return input.fallback;
  }
  if (TRUE_ENV_VALUES.has(raw)) {
    return true;
  }
  if (FALSE_ENV_VALUES.has(raw)) {
    return false;
  }
  return input.fallback;
}

export function readByteLimitEnv(input: {
  readonly envVarName: string;
  readonly fallbackEnvVarNames?: readonly string[];
  readonly fallbackBytes: number;
  readonly minimumBytes?: number;
}): number {
  const minimumBytes = input.minimumBytes ?? 1;
  const envVarNames = [input.envVarName, ...(input.fallbackEnvVarNames ?? [])];

  for (const envVarName of envVarNames) {
    const raw = process.env[envVarName]?.trim().toLowerCase();
    if (!raw) {
      continue;
    }

    const match = raw.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)?$/);
    if (!match) {
      continue;
    }

    const value = Number.parseFloat(match[1] ?? "");
    const unit = match[2] ?? "mb";
    const multiplier = BYTE_UNITS[unit];
    if (!Number.isFinite(value) || multiplier === undefined) {
      continue;
    }

    return Math.max(minimumBytes, Math.floor(value * multiplier));
  }

  return Math.max(minimumBytes, input.fallbackBytes);
}

export function runBestEffortGarbageCollection(): boolean {
  const maybeGc = (globalThis as { gc?: unknown }).gc;
  if (typeof maybeGc !== "function") {
    return false;
  }
  maybeGc();
  return true;
}
