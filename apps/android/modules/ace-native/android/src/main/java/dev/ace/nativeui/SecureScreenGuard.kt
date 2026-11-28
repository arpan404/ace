package dev.ace.nativeui

import android.app.Activity
import android.util.Log
import android.view.WindowManager

/**
 * Fail-closed recents/screenshot guard for the app lock.
 *
 * The window must be excluded from the switcher before any JS runs: Android
 * snapshots whatever the compositor last drew, which can predate the first
 * JS `AppState` event. The first-frame claim happens in `MainActivity.onCreate`
 * (see `plugins/with-ace-secure-screen.ts`), which runs at actual Activity
 * creation before the Expo module exists. This holder keeps the desired state
 * (defaulting to secure) so every creation/start/resume re-applies it, and JS
 * later relaxes it once the durable lock choice is loaded and the lock is off.
 */
object SecureScreenGuard {
  @Volatile
  var desiredSecure: Boolean = true

  fun applyTo(activity: Activity) {
    try {
      val window = activity.window ?: return
      if (desiredSecure) {
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      } else {
        window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
    } catch (error: Exception) {
      // A window that is gone mid-recreation must not crash the caller: the
      // desired state is retained and the next Activity applies it. Log so a
      // persistent addFlags failure (fail-open) stays visible instead of
      // silently leaving the window unsecured.
      Log.w("SecureScreenGuard", "applyTo(desiredSecure=$desiredSecure) failed", error)
    }
  }
}
