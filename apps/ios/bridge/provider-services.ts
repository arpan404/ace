import type { ClientCore } from "@ace/client";
import { ProviderInstallAct, ProviderInstallWatch, ProviderInstalls } from "./provider-install.ts";
import {
  machineLabel,
  OtherProvidersRequest,
  ProviderEditRequest,
  ProviderPageRequest,
  ProviderPages,
} from "./provider-page.ts";

/*
 * The native service calls behind a provider's Settings page, in one place for the service
 * router: its page read, the off and missing providers, preference edits and CLI installs.
 * Anything else answers undefined and goes on to the other services.
 */
export class ProviderServices {
  readonly pages: ProviderPages;
  readonly installs: ProviderInstalls;
  constructor(owner: ClientCore) {
    const machine = machineLabel(owner);
    this.pages = new ProviderPages(owner, machine);
    this.installs = new ProviderInstalls(owner, machine);
  }

  async answer(raw: unknown, signal: AbortSignal): Promise<{ value: unknown } | undefined> {
    const page = ProviderPageRequest.safeParse(raw);
    if (page.success) return { value: await this.pages.page(page.data, signal) };
    if (OtherProvidersRequest.safeParse(raw).success)
      return { value: await this.pages.others(signal) };
    const edit = ProviderEditRequest.safeParse(raw);
    if (edit.success) return { value: await this.pages.edit(edit.data, signal) };
    const watch = ProviderInstallWatch.safeParse(raw);
    if (watch.success) return { value: await this.installs.watch(watch.data, signal) };
    const act = ProviderInstallAct.safeParse(raw);
    if (act.success) return { value: await this.installs.act(act.data) };
    return undefined;
  }
}
