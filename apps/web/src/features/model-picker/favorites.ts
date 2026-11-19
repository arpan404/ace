import { useClient } from "@ace/client-react";
import { ProviderConfiguration, ProviderKind } from "@ace/protocol";
import {
  catalogModelIds,
  changeProvider,
  editProviderConfiguration,
  favoriteModelKeys,
  readJson,
  withFavoriteToggled,
} from "@ace/ui-core";
import { useQueryClient } from "@tanstack/react-query";
import { catalogKey, useModelCatalog } from "@/lib/model-catalog.ts";
import { useEffect, useMemo } from "react";
import * as z from "zod/mini";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useLayout } from "@/lib/layout.tsx";

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
  const catalog = useModelCatalog();
  const canonical = useMemo(() => catalogModelIds(catalog ?? []), [catalog]);
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
    favorites: favoriteModelKeys(rows ?? [], canonical),
    toggle(key) {
      void editProviderConfiguration(
        client,
        (before) => withFavoriteToggled(before, key, canonical) ?? before,
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
