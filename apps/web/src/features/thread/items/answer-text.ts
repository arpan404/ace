import type { ClientApi } from "@ace/client";
import type { ContentPart, Item } from "@ace/protocol";
import { useClient } from "@ace/client-react";
import { useEffect, useRef, useState } from "react";

const maxAnswerBytes = 8 * 1024 * 1024;
const empty: readonly ContentPart[] = [];
const isPreview = (part: ContentPart) =>
  part.type === "text" && part.source !== undefined && part.source.bytes > part.text.length * 2;

/** Reads only source-backed parts that exceed the snapshot's preview, with a render-size bound. */
export async function readAnswerText(
  client: ClientApi,
  parts: readonly ContentPart[],
  signal: AbortSignal,
): Promise<string> {
  const bytes = parts.reduce(
    (total, part) =>
      total + (part.type === "text" ? Math.max(part.text.length * 2, part.source?.bytes ?? 0) : 0),
    0,
  );
  if (bytes > maxAnswerBytes)
    throw new Error("This answer is too large to display here. You can still copy the preview.");
  const chunks: string[] = [];
  let loadedBytes = 0;
  for (const part of parts) {
    if (part.type !== "text") continue;
    if (isPreview(part) && part.source) {
      for await (const chunk of client.text(part.source, { signal })) {
        loadedBytes += chunk.length * 2;
        if (loadedBytes > maxAnswerBytes)
          throw new Error("This answer is too large to display here.");
        chunks.push(chunk);
      }
    } else {
      loadedBytes += part.text.length * 2;
      chunks.push(part.text);
    }
  }
  return chunks.join("");
}

type ReadState = {
  key: string;
  status: "loading" | "ready" | "failed";
  text?: string;
  problem?: string;
};

export function useAnswerText(item: Item | undefined) {
  const client = useClient();
  const parts = item?.type === "message" ? item.parts : empty;
  const truncated = item?.complete === true && parts.some(isPreview);
  const key = truncated ? JSON.stringify([item.id, parts]) : "";
  const [state, setState] = useState<ReadState>();
  const active = useRef<
    { client: ClientApi; key: string; controller: AbortController } | undefined
  >(undefined);
  useEffect(
    () => () => {
      if (active.current?.client === client && active.current.key === key)
        active.current.controller.abort();
    },
    [client, key],
  );
  const current = state?.key === key ? state : undefined;
  const preview = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  const load = () => {
    active.current?.controller.abort();
    const controller = new AbortController();
    active.current = { client, key, controller };
    setState({ key, status: "loading" });
    void readAnswerText(client, parts, controller.signal).then(
      (text) => {
        if (!controller.signal.aborted) setState({ key, status: "ready", text });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            key,
            status: "failed",
            problem: error instanceof Error ? error.message : "Couldn't load the full answer.",
          });
      },
    );
  };
  return {
    text: current?.text ?? preview,
    partial: truncated && current?.status !== "ready",
    status: current?.status,
    problem: current?.problem,
    load,
  };
}
