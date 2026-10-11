import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { onboardingKey } from "@/lib/provider-readiness.ts";
import { settingsQueries, useSettingsBackend } from "./data/use-settings.ts";

/** Look for installed CLIs and their sign-ins again (after installing one, say). */
export function RediscoverButton() {
  const backend = useSettingsBackend();
  const toast = useToast();
  const queryClient = useQueryClient();
  const rediscover = useMutation({
    mutationFn: () => backend.rediscover(),
    onError: () =>
      toast.error({
        title: "Couldn't check providers",
        actionProps: { children: "Retry", onClick: () => rediscover.mutate() },
      }),
    onSuccess: (list) => {
      queryClient.setQueryData(settingsQueries.providers(backend).queryKey, list);
      // Readiness and the pickers' statuses (both under "providers"), and setup's checklist.
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      void queryClient.invalidateQueries({ queryKey: onboardingKey });
    },
  });
  return (
    <IconButton
      size="sm"
      icon={ArrowClockwiseIcon}
      label={rediscover.isPending ? "Checking…" : "Check again"}
      onClick={() => rediscover.mutate()}
      disabled={rediscover.isPending}
    />
  );
}
