import { SettingsService } from "@ace/settings";
import { createLogger } from "@ace/diagnostics";
import type { McpAttribution } from "@ace/protocol";
import { readConfig } from "../config.ts";
import { end } from "../engine/test-support.ts";
import { Resources } from "../services/resources.ts";
import type { ServiceContext } from "../services/types.ts";
import { createAgentOwners } from "./owners.ts";
import type { ExtensionOperation } from "./tools.ts";
import { setup } from "./test-support.ts";

/** Real ownership, settings, delegation and SQLite; only the provider CLI is scripted. */
export async function automationFixture() {
  const h = setup();
  const caller = await h.parent();
  let sequence = 0;
  const open = async () => {
    const resources = new Resources();
    const settings = new SettingsService({ dataDir: h.home });
    resources.own(() => settings.close());
    const log = createLogger({
      now: h.clock.now,
      level: "silent",
      redact: (line) => line,
      sink: { async write() {}, async close() {} },
    });
    resources.own(() => log.close());
    const onListen: (() => void | Promise<void>)[] = [];
    const context = {
      config: readConfig({ ACE_HOME: h.home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
      signal: new AbortController().signal,
      options: { engine: { registry: h.registry, clock: h.clock } },
      store: h.store,
      now: h.clock.now,
      id: () => `automation-${++sequence}`,
      resources,
      log,
      services: { settings },
      onListen,
    } satisfies ServiceContext;
    const owners = createAgentOwners(context, h.service);
    for (const listen of onListen) await listen();
    return { resources, settings, owners };
  };
  let owner = await open();
  return {
    h,
    caller,
    get settings() {
      return owner.settings;
    },
    call(operation: ExtensionOperation, identity: McpAttribution = caller) {
      return owner.owners.execute(identity, operation, new AbortController().signal);
    },
    async restart() {
      await owner.resources.close();
      owner = await open();
    },
    async close() {
      await owner.resources.close();
      for (const context of h.contexts.values()) context.onFrame(h.frames.frame(end));
      await h.engine.flush();
      await h.close();
    },
  };
}
