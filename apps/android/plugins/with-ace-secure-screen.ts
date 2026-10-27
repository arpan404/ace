import { withMainActivity, type ConfigPlugin } from "expo/config-plugins";
import { applySecureScreenToMainActivity } from "./secure-screen-text.ts";

/**
 * Fail-closed recents guard from actual Activity creation.
 *
 * The Expo module `OnCreate` callback runs after the Activity exists, so it
 * cannot claim `FLAG_SECURE` before the first frame: the compositor snapshot
 * used by the switcher can predate any module or JS code. This plugin sets
 * the flag in `MainActivity.onCreate` before `super.onCreate`, so the window
 * is excluded from the switcher starting with its very first frame, on every
 * creation including rotation and process restart. The native module keeps
 * the desired state and re-applies it at runtime; JS later clears the flag
 * once the durable lock choice is loaded and the lock is off.
 */
const withAceSecureScreen: ConfigPlugin = (config) =>
  withMainActivity(config, (mod) => {
    mod.modResults.contents = applySecureScreenToMainActivity(mod.modResults.contents);
    return mod;
  });

export default withAceSecureScreen;
