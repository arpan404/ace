import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { useContext, useSyncExternalStore } from "react";
import { readForge } from "@/lib/forge-read.ts";
import type { ForgeScope } from "./media-loads.ts";
import { ForgeContentScope } from "./scope.ts";

/*
 * GitHub's image-only emoji (`:octocat:`, `:shipit:`), shortcode to image URL, read once per
 * connection and forge host when text first holds a shortcode GitHub's Unicode list doesn't
 * know. The images themselves load through the daemon like any other media.
 */

type Entry = { images: ReadonlyMap<string, string> | undefined; listeners: Set<() => void> };
const lists = new WeakMap<ClientApi, Map<string, Entry>>();
const none = new Map<string, string>();

function entryFor(client: ClientApi, scope: ForgeScope): Entry {
  let byHost = lists.get(client);
  if (!byHost) {
    byHost = new Map();
    lists.set(client, byHost);
  }
  let entry = byHost.get(scope.repository.host);
  if (!entry) {
    const created: Entry = { images: undefined, listeners: new Set() };
    entry = created;
    byHost.set(scope.repository.host, created);
    void readForge(
      client,
      { op: "forge.emoji.images", workspaceId: scope.workspaceId, repository: scope.repository },
      new AbortController().signal,
    ).then(
      (reply) => {
        created.images = new Map(
          reply.resource === "emojiImages" ? Object.entries(reply.images) : [],
        );
        for (const listener of created.listeners) listener();
      },
      () => {
        // Not readable now: shortcodes stay text, and the next page asks again.
        byHost?.delete(scope.repository.host);
      },
    );
  }
  return entry;
}

/** The forge's image emoji once read (starting the read when `wanted`); empty until then. */
export function useImageEmoji(wanted: boolean): ReadonlyMap<string, string> {
  const client = useClient();
  const scope = useContext(ForgeContentScope);
  const entry = wanted && scope ? entryFor(client, scope) : undefined;
  return useSyncExternalStore(
    (listener) => {
      entry?.listeners.add(listener);
      return () => entry?.listeners.delete(listener);
    },
    () => entry?.images ?? none,
    () => entry?.images ?? none,
  );
}
