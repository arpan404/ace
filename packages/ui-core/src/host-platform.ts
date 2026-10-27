import { HostPlatform } from "@ace/protocol";

/**
 * The machine's operating system from its identity's `platform`: one of the three clients know,
 * or undefined when the daemon is older and doesn't say, or names one this client doesn't know.
 */
export function hostPlatform(platform: string | undefined): HostPlatform | undefined {
  return HostPlatform.safeParse(platform).data;
}
