import { useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";

/**
 * `spade.enabled` (ADR 0121): global and admin only, so a device without admin is refused and
 * told so. Returns the value, a setter that reports its own failure, and whether a change is out.
 */
export function useSpadeEnabled() {
  const [enabled, set] = useDaemonSetting("spade.enabled");
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const change = async (next: boolean) => {
    setSaving(true);
    try {
      await set(next);
    } catch {
      toast.error({
        title: next ? "Couldn't turn on Spade" : "Couldn't turn off Spade",
        description: "Only a device with admin access to this machine can change it.",
      });
    } finally {
      setSaving(false);
    }
  };
  return [enabled, change, saving] as const;
}
