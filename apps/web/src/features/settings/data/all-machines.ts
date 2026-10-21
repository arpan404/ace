import type { ClientApi } from "@ace/client";
import { createContext, use } from "react";

/*
 * "All machines" in Settings: a page reads this window's own machine and every settings write
 * goes to every connected machine, so one change sets them all. Only pages whose settings mean
 * the same thing on every machine offer it (Agents, Browser); the rest are per machine.
 */

/**
 * A client that reads from `primary` and sends each `settings.set` to `primary` and every
 * client in `others`. A write fails if any machine refuses it, so the page never claims a value
 * every machine doesn't hold; machines that took it keep it.
 */
export function fanOutClient(primary: ClientApi, others: readonly ClientApi[]): ClientApi {
  const request: ClientApi["request"] = async (message, options) => {
    if (message.type !== "settings.set") return primary.request(message, options);
    const [reply] = await Promise.all([
      primary.request(message, options),
      ...others.map((client) => client.request(message, options)),
    ]);
    return reply;
  };
  return new Proxy(primary, {
    get(target, property) {
      if (property === "request") return request;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The other machines a page in "All machines" writes to; empty when a single machine is picked. */
export const AllMachinesClients = createContext<readonly ClientApi[]>([]);

export function useAllMachinesClients(): readonly ClientApi[] {
  return use(AllMachinesClients);
}
