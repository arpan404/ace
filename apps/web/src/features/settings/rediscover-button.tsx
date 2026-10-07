import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button.tsx";
import { onboardingKey } from "@/lib/provider-readiness.ts";
import { settingsQueries, useSettingsBackend } from "./data/use-settings.ts";

/** Look for installed CLIs and their sign-ins again (after installing one, say). */
export function RediscoverButton() {
  const backend = useSettingsBackend();
  const queryClient = useQueryClient();
  const rediscover = useMutation({
    mutationFn: () => backend.rediscover(),
    onSuccess: (list) => {
      queryClient.setQueryData(settingsQueries.providers(backend).queryKey, list);
      // Readiness and the pickers' statuses (both under "providers"), and setup's checklist.
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      void queryClient.invalidateQueries({ queryKey: onboardingKey });
    },
  });
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => rediscover.mutate()}
      disabled={rediscover.isPending}
    >
      <ArrowClockwiseIcon aria-hidden size={13} />
      {rediscover.isPending ? "Checking…" : "Check again"}
    </Button>
  );
}
