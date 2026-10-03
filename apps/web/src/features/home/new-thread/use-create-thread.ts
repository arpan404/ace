import type { SidebarReader } from "@ace/client";
import { useClient, useIntent, useSidebar, useSidebarIds } from "@ace/client-react";
import { WorkspaceId, type CommandPayload, type MessageContext } from "@ace/protocol";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

export interface CreateRequest {
  project: string;
  provider: Extract<CommandPayload, { type: "thread.create" }>["provider"];
  model: string | undefined;
  text: string;
  context?: MessageContext | undefined;
}

interface Pending {
  intentId: string;
  project: string;
  /** Threads that existed when the request was sent; the new one is the first id after. */
  before: ReadonlySet<string>;
}

const none: readonly string[] = [];

/**
 * Send `thread.create` as a durable intent and open the thread once the daemon lists it. The
 * command result carries no thread id, so the new thread is the first one to appear in that
 * project after sending.
 */
export function useCreateThread(): {
  /** Resolves false when the request could not be sent, so the draft stays in the composer. */
  create(request: CreateRequest): Promise<boolean>;
  sending: boolean;
  error: string | undefined;
} {
  const client = useClient();
  const navigate = useNavigate();
  const ids = useSidebarIds() ?? none;
  const [pending, setPending] = useState<Pending>();
  const [failure, setFailure] = useState<string>();
  const intent = useIntent(pending?.intentId);

  const findCreated = useCallback(
    (reader: SidebarReader) =>
      pending
        ? reader.ids.find(
            (id) => !pending.before.has(id) && reader.thread(id)?.workspaceId === pending.project,
          )
        : undefined,
    [pending],
  );
  const created = useSidebar(
    useMemo(() => ["ids" as const], []),
    findCreated,
  );
  useEffect(() => {
    if (created)
      void navigate({ to: "/t/$threadId", params: { threadId: created }, replace: true });
  }, [created, navigate]);

  const create = useCallback(
    async (request: CreateRequest) => {
      setFailure(undefined);
      const payload: CommandPayload = {
        type: "thread.create",
        workspaceId: WorkspaceId.parse(request.project),
        provider: request.provider,
        // TODO(client-gaps): feat/client-protocol-gaps adds account, mode and baseBranch to
        // thread.create and returns the new thread id in the receipt.
        ...(request.model ? { model: request.model } : {}),
        input: [{ type: "text", text: request.text }],
        ...(request.context ? { context: request.context } : {}),
      };
      const before = new Set(ids);
      try {
        const intentId = await client.enqueue(payload);
        setPending({ intentId, project: request.project, before });
        return true;
      } catch {
        setFailure("Couldn't send the request. Check the connection and try again.");
        return false;
      }
    },
    [client, ids],
  );

  const rejected = intent?.state === "failed";
  const error =
    failure ??
    (rejected
      ? `The daemon didn't start the thread${intent.error ? ` (${intent.error})` : ""}.`
      : undefined);
  return { create, sending: pending !== undefined && !rejected, error };
}
