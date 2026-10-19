import { useDeviceToggle } from "./device-toggle.ts";

/**
 * "Picture in picture" (Settings › Browser), kept current: whether a thread's page floats in
 * picture-in-picture by itself when the person leaves its Browser while an agent browses or the
 * page plays sound. On unless turned off.
 */
export function useAutomaticPip(): [boolean, (value: boolean) => void] {
  return useDeviceToggle("ace.browser.pip.automatic", true);
}
