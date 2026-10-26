import {
  HOST_CONTRACT_VERSION,
  requiredFunctions,
  type HostErrorCode,
  type HostOperation,
  type HostOperations,
  type NativeHost,
  type OptionalCapability,
} from "./contract.ts";

/** The host is missing, too old or incomplete: the bundle and the app don't match. */
export class HostContractError extends Error {
  constructor(problem: string) {
    super(`Native host contract: ${problem}`);
    this.name = "HostContractError";
  }
}

/** An async host operation failed. `message` is the code, which callers may match on. */
export class HostCallError extends Error {
  readonly code: HostErrorCode;
  readonly operation: string;
  constructor(operation: string, code: string) {
    const known = codes.has(code) ? (code as HostErrorCode) : "failed";
    super(known);
    this.name = "HostCallError";
    this.code = known;
    this.operation = operation;
  }
}
const codes = new Set<string>([
  "unsupported",
  "storage",
  "identity",
  "invalid",
  "pin",
  "redirect",
  "offline",
  "limit",
  "failed",
]);

/**
 * Checks that `candidate` (normally `globalThis.aceHost`) implements this contract, so a
 * mismatched app and bundle fail at start with the reason, not later at some call.
 */
export function connectHost(candidate: unknown): NativeHost {
  if (typeof candidate !== "object" || candidate === null) throw new HostContractError("missing");
  const version: unknown = Reflect.get(candidate, "version");
  if (typeof version !== "number" || version < HOST_CONTRACT_VERSION)
    throw new HostContractError(`version ${String(version)}, need ${HOST_CONTRACT_VERSION}`);
  const capabilities: unknown = Reflect.get(candidate, "capabilities");
  if (!Array.isArray(capabilities)) throw new HostContractError("no capabilities list");
  for (const name of requiredFunctions)
    if (typeof Reflect.get(candidate, name) !== "function")
      throw new HostContractError(`${name} missing`);
  for (const name of capabilities)
    if (typeof Reflect.get(candidate, name) !== "function")
      throw new HostContractError(`${String(name)} listed but missing`);
  // Every member was just checked against the contract.
  return candidate as NativeHost;
}

/** Whether `host` offers an optional capability. */
export function hasCapability(host: NativeHost, name: OptionalCapability): boolean {
  return host.capabilities.includes(name) && typeof host[name] === "function";
}

type Input<Op extends HostOperation> = HostOperations[Op]["input"];
type Body<Op extends HostOperation> = HostOperations[Op]["body"];
type Args<Op extends HostOperation> = [Body<Op>] extends [never]
  ? Input<Op> extends null
    ? []
    : [input: Input<Op>]
  : [input: Input<Op>, body: Body<Op>];

/** Typed async operations over `host.call`; failures reject with `HostCallError`. */
export function requester(host: NativeHost) {
  return function request<Op extends HostOperation>(
    operation: Op,
    ...args: Args<Op>
  ): Promise<string> {
    const [input = null, body] = args as [unknown, string | undefined];
    return new Promise((resolve, reject) => {
      host.call(operation, JSON.stringify(input), body, (error, value) => {
        if (error !== null) reject(new HostCallError(operation, error));
        else resolve(value);
      });
    });
  };
}
export type HostRequest = ReturnType<typeof requester>;

/** The SDK's scheduler on host timers. */
export function hostScheduler(host: NativeHost): {
  set(delay: number, callback: () => void): () => void;
} {
  return {
    set(delay, callback) {
      const id = host.uuid();
      host.timer(id, delay, callback);
      return () => host.cancelTimer(id);
    },
  };
}
