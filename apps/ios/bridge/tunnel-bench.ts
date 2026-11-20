import { openMachineTunnel } from "@ace/client/machine-tunnel";
import { portableReadableStream } from "@ace/native-host";
import { call, host, scheduler } from "./host.ts";
import { DeviceLoopback } from "./device-loopback.ts";
import { nativeLoopbackHost } from "./device-host.ts";
import { memoryMachine } from "./tunnel-memory-machine.ts";

/*
 * The bridge's loopback throughput bench (debug builds, `--loopback-bench`): the phone's real
 * listeners and the real tunnel and stream mux, to an in-memory machine in this same runtime, so
 * what it measures is moving bytes between Swift sockets and the tunnel through JavaScriptCore,
 * framing included, with no network. Swift fetches through the port and times it.
 */

let bench: DeviceLoopback | undefined;
const schedule = (run: () => void, delay: number) => scheduler.set(delay, run);

/** Starts listening on `port`; answers the listen result. */
export async function startLoopbackBench(port: number): Promise<string> {
  const machine = memoryMachine({ ports: [port], schedule });
  const tunnel = openMachineTunnel({
    path: { get: () => machine, subscribe: () => () => {} },
    schedule,
    ReadableStream: portableReadableStream,
  });
  const loopback = nativeLoopbackHost(host, call);
  bench = new DeviceLoopback(loopback, () => tunnel, { port: () => {}, released: () => {} });
  // Port 80 too: whether the phone lets an app take a port under 1024 (`app.localhost`).
  return JSON.stringify(await loopback.listen([port, 80]));
}

/** Loopback events while the bench runs. */
export function benchLoopback(): DeviceLoopback | undefined {
  return bench;
}
