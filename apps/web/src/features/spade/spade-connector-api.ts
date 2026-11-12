import {
  parseSpadeConnectStart,
  parseSpadeConnector,
  parseSpadeConnectorAccess,
  parseSpadeConnectors,
  type SpadeConnectStart,
  type SpadeConnectorAccess,
} from "@ace/ui-core/spade-chat";
import { useQuery } from "@tanstack/react-query";
import { segment, spadeHttp, type SpadeTarget } from "./spade-requests.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";

/*
 * Spade's connector routes (ADR 0131, spade/docs/connectors.md), each answer parsed with
 * `@ace/ui-core/spade-chat`. A token typed for a connector goes to Spade in one request and is
 * never kept here.
 */

function sure<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Spade's ${what} didn't make sense.`);
  return value;
}

type Signal = { signal?: AbortSignal | undefined };

export async function readConnectors(target: SpadeTarget, options: Signal = {}) {
  const body = await spadeHttp(target, "GET", "/v1/connectors", options);
  return sure(parseSpadeConnectors(body), "connectors");
}

/** What names a server and how to sign in to it; one of `catalogue` or `url`. */
export interface SpadeConnectDraft {
  catalogue?: string;
  url?: string;
  name?: string;
  token?: string;
  client_id?: string;
  client_secret?: string;
}

export async function connect(
  target: SpadeTarget,
  draft: SpadeConnectDraft,
): Promise<SpadeConnectStart> {
  const body = await spadeHttp(target, "POST", "/v1/connectors", { body: draft });
  return sure(parseSpadeConnectStart(body), "answer");
}

/** Signs in to a connector again, optionally with a new token or client. */
export async function reconnect(
  target: SpadeTarget,
  id: string,
  draft: Omit<SpadeConnectDraft, "catalogue" | "url" | "name"> = {},
): Promise<SpadeConnectStart> {
  const path = `/v1/connectors/${segment(id)}/connect`;
  return sure(
    parseSpadeConnectStart(await spadeHttp(target, "POST", path, { body: draft })),
    "answer",
  );
}

export async function readConnector(target: SpadeTarget, id: string) {
  const body = await spadeHttp(target, "GET", `/v1/connectors/${segment(id)}`);
  return sure(parseSpadeConnector(body), "connector");
}

export async function disconnect(target: SpadeTarget, id: string): Promise<void> {
  await spadeHttp(target, "DELETE", `/v1/connectors/${segment(id)}`);
}

export async function readAccess(target: SpadeTarget, agent: string, options: Signal = {}) {
  const body = await spadeHttp(target, "GET", `/v1/agents/${segment(agent)}/connectors`, options);
  return sure(parseSpadeConnectorAccess(body), "allow list");
}

export async function setAccess(
  target: SpadeTarget,
  agent: string,
  access: SpadeConnectorAccess,
): Promise<SpadeConnectorAccess> {
  const path = `/v1/agents/${segment(agent)}/connectors`;
  const body = await spadeHttp(target, "PUT", path, { body: access });
  return sure(parseSpadeConnectorAccess(body), "allow list");
}

/** Every connectors read; one machine's under `[...connectorsKey, machine key]`. */
export const connectorsKey = ["spade", "connectors"] as const;

/**
 * The catalogue and the person's connectors on the machine in scope, read again every two
 * seconds while one is signing in or connecting, so its row follows the browser.
 */
export function useSpadeConnectors(ready = true) {
  const machine = useSpadeMachine().key;
  const client = useSpadeClient();
  return useQuery({
    queryKey: [...connectorsKey, machine],
    queryFn: ({ signal }) => readConnectors(client, { signal }),
    enabled: ready,
    refetchInterval: (query) =>
      query.state.data?.connectors.some(
        (each) => each.state === "signing_in" || each.state === "connecting",
      )
        ? 2_000
        : false,
  });
}

/** A bot's allow list on the machine in scope. */
export function useConnectorAccess(agent: string) {
  const machine = useSpadeMachine().key;
  const client = useSpadeClient();
  return useQuery({
    queryKey: [...connectorsKey, machine, "access", agent],
    queryFn: ({ signal }) => readAccess(client, agent, { signal }),
  });
}
