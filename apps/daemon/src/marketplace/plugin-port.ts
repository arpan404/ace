import type { PluginService } from "@ace/plugins";
import type { PluginResponse } from "@ace/protocol/plugins";
import type { PluginPort } from "./install.ts";

/** The marketplace's way into ADR 0014's plugin manager: the same accept, remove and switches. */
export function pluginPort(service: () => PluginService | undefined): PluginPort {
  const plugin = (request: unknown): Promise<PluginResponse> => {
    const plugins = service();
    if (!plugins) return Promise.reject(new Error("Plugins aren't ready"));
    return plugins.handle(request);
  };
  return {
    prepareFiles: (input) => {
      const plugins = service();
      if (!plugins) throw new Error("Plugins aren't ready");
      return plugins.prepareFiles(input);
    },
    accept: async (review) => {
      await plugin({ type: "plugins.accept", ...review });
    },
    remove: async (name) => {
      await plugin({ type: "plugins.remove", name });
    },
    cancel: async (id) => {
      await plugin({ type: "plugins.cancel", id });
    },
    accepted: async (name) => {
      const list = await plugin({ type: "plugins.list" });
      const install =
        list.type === "plugins.list" ? list.installs.find((item) => item.name === name) : undefined;
      return install
        ? { hash: install.hash, commit: install.commit, version: install.version }
        : undefined;
    },
    availability: async (name) => {
      const list = await plugin({ type: "plugins.list" });
      const current =
        list.type === "plugins.list"
          ? list.availability?.find((item) => item.name === name)
          : undefined;
      return current ? { enabled: current.enabled, providers: [...current.providers] } : undefined;
    },
    setAvailability: async (name, availability) => {
      await plugin({ type: "plugins.availability", name, ...availability });
    },
    setEnabled: async (name, enabled) => {
      const list = await plugin({ type: "plugins.list" });
      const current =
        list.type === "plugins.list"
          ? list.availability?.find((item) => item.name === name)
          : undefined;
      await plugin({
        type: "plugins.availability",
        name,
        enabled,
        providers: current?.providers ?? [],
      });
    },
  };
}
