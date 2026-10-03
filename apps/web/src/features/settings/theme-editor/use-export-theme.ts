import { useCallback } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { themeToFile } from "@/theme/custom-themes.ts";
import type { Theme } from "@/theme/presets.ts";

/** Export a theme as JSON: download it and copy it, then say which of the two worked. */
export function useExportTheme(): (theme: Theme) => Promise<void> {
  const toast = useToast();
  return useCallback(
    async (theme: Theme) => {
      const json = themeToFile(theme);
      const downloaded = download(`ace-theme-${theme.id.replace(/[^\w-]+/g, "-")}.json`, json);
      let copied = true;
      try {
        await navigator.clipboard.writeText(json);
      } catch {
        copied = false;
      }
      const how = [downloaded && "JSON downloaded", copied && "copied"]
        .filter(Boolean)
        .join(" and ");
      toast.add({
        title: how ? `Exported ${theme.name} · ${how}` : `Couldn't export ${theme.name}`,
      });
    },
    [toast],
  );
}

function download(name: string, text: string): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}
