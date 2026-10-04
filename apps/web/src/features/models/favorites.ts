import { readJson, toggleFavorite, writeJson } from "@ace/ui-core";
import { useState } from "react";
import * as z from "zod/mini";
import { useLayout } from "@/lib/layout.tsx";

/** Starred models by picker key (`modelKey`), kept on this device like other UI preferences. */
const Favorites = z.catch(z.array(z.string()), []);
const favoritesKey = "ace.models.favorites";

export function useFavoriteModels(): {
  favorites: readonly string[];
  toggle(key: string): void;
} {
  const { storage } = useLayout();
  const [favorites, setFavorites] = useState<readonly string[]>(() =>
    readJson(storage, favoritesKey, Favorites, []),
  );
  return {
    favorites,
    toggle(key) {
      // Read again first, so another window's stars are kept.
      const next = toggleFavorite(readJson(storage, favoritesKey, Favorites, []), key);
      writeJson(storage, favoritesKey, next);
      setFavorites(next);
    },
  };
}
