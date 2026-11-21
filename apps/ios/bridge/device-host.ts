import { hasCapability, type LoopbackListening, type NativeHost } from "@ace/native-host";
import { z } from "zod";
import type { HostRequest } from "@ace/native-host";
import type { LoopbackHost } from "./device-loopback.ts";

/*
 * The phone's loopback listeners through the native host (`loopback`, ADR 0194). A host without
 * the capability (an older app) listens on nothing, so device tabs still open public pages.
 */

const Listening = z.object({
  listening: z.array(z.number().int()),
  busy: z.array(z.number().int()),
});

export function nativeLoopbackHost(host: NativeHost, call: HostRequest): LoopbackHost {
  const act = host.loopback;
  if (!act || !hasCapability(host, "loopback"))
    return {
      listen: async (): Promise<LoopbackListening> => ({ listening: [], busy: [] }),
      act: () => {},
    };
  return {
    async listen(ports) {
      return Listening.parse(JSON.parse(await call("loopback.listen", { ports })));
    },
    act: (connection, action, bytes) => act.call(host, connection, action, bytes),
  };
}
