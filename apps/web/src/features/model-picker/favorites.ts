import { useClient } from "@ace/client-react";
import { ProviderConfiguration, ProviderKind } from "@ace/protocol";
import { modelKey, readJson, toggleFavorite } from "@ace/ui-core";
import { useQueryClient } from "@tanstack/react-query";
import { catalogKey } from "@/lib/model-catalog.ts";
import { useEffect } from "react";
import * as z from "zod/mini";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useLayout } from "@/lib/layout.tsx";
import { changeProvider, editProviderConfiguration } from "@/lib/provider-configuration.ts";

const Favorites = z.catch(z.array(z.string()), []);
const favoritesKey = "ace.models.favorites";
const migrations = new WeakMap<object, Promise<void>>();
const favoriteId = ProviderConfiguration.shape.favourites.unwrap().element;

/** Stars live with provider preferences. Old device stars move once, after a successful save. */
export function useFavoriteModels(): {
  favorites: readonly string[];
  toggle(key: string): void;
} {
  const client = useClient();
  const { storage } = useLayout();
  const [rows] = useDaemonSetting("providers.configuration");
  const toast = useToast();
  const query = useQueryClient();
  useEffect(() => {
    if (!rows || !storage || !storage.getItem(favoritesKey) || migrations.has(storage)) return;
    const old = readJson(storage, favoritesKey, Favorites, []);
    const migrate = editProviderConfiguration(client, (before) => {
      let next = before;
      for (const key of old) {
        const split = key.indexOf("\u0000");
        const provider = ProviderKind.safeParse(key.slice(0, split));
        const id = favoriteId.safeParse(key.slice(split + 1));
        if (split < 0 || !provider.success || !id.success) continue;
        next = changeProvider(next, provider.data, (row) => ({
          ...row,
          favourites: [...new Set([...(row.favourites ?? []), id.data])].slice(0, 512),
        }));
      }
      return next;
    }).then(async () => {
      storage.removeItem?.(favoritesKey);
      await query.invalidateQueries({ queryKey: catalogKey });
    });
    migrations.set(storage, migrate);
    void migrate.catch(() => {
      migrations.delete(storage);
    });
  }, [client, storage, rows, query]);
  return {
    favorites: (rows ?? []).flatMap((row) =>
      row.instance === undefined
        ? (row.favourites ?? []).map((id) => modelKey(row.provider, id))
        : [],
    ),
    toggle(key) {
      const split = key.indexOf("\u0000");
      const provider = ProviderKind.safeParse(key.slice(0, split));
      if (split < 0 || !provider.success) return;
      const id = key.slice(split + 1);
      void editProviderConfiguration(client, (before) =>
        changeProvider(before, provider.data, (row) => ({
          ...row,
          favourites: toggleFavorite(row.favourites ?? [], id),
        })),
      )
        .then(() => query.invalidateQueries({ queryKey: catalogKey }))
        .catch(() =>
          toast.error({
            title: "Couldn't save this favourite",
            description: "Reconnect and try again.",
          }),
        );
    },
  };
}
