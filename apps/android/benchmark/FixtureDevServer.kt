@file:Suppress("DEPRECATION")

package dev.ace.android.benchmark

import android.content.Context
import android.preference.PreferenceManager

// TEST-ONLY helper: points ordinary React Native dev settings at the fixture
// Metro (localhost:8083) for the fixture-send scenario only. React Native
// debug settings (product debug path) reads this key; SpikeInstrumentation
// configures then restores it around launch.
//
// Store/key evidence from installed RN 0.86.3 (apps/android/node_modules):
// - PackagerConnectionSettings.kt:19-20 uses
//   PreferenceManager.getDefaultSharedPreferences(appContext); :79 declares
//   PREFS_DEBUG_SERVER_HOST_KEY = "debug_http_host"; :35 reads it via
//   preferences.getString(PREFS_DEBUG_SERVER_HOST_KEY, null).
// - DevInternalSettings.kt:27-28 uses the same default SharedPreferences.
// Both import android.preference.PreferenceManager (platform, not AndroidX),
// so this helper uses the same platform call: same store, no new dependency.
object FixtureDevServer {
  const val DEBUG_SERVER_HOST_KEY = "debug_http_host"
  const val FIXTURE_HOST = "localhost:8083"

  class Prior(val hadKey: Boolean, val value: String?) {
    init {
      check((hadKey && value != null) || (!hadKey && value == null)) {
        "Prior must be a String or absence"
      }
    }
  }

  fun configure(targetContext: Context): Prior {
    val prefs = PreferenceManager.getDefaultSharedPreferences(targetContext)
    val hadKey = prefs.contains(DEBUG_SERVER_HOST_KEY)
    val prior = if (hadKey) {
      // Refuse conservatively before mutating: present null or non-String
      // never becomes a Prior; only an exact String is preserved.
      val existing = prefs.all[DEBUG_SERVER_HOST_KEY]
      if (existing !is String) {
        throw IllegalStateException("debug_http_host is not a String")
      }
      Prior(true, existing)
    } else {
      Prior(false, null)
    }
    val committed: Boolean
    try {
      committed = prefs.edit().putString(DEBUG_SERVER_HOST_KEY, FIXTURE_HOST).commit()
    } catch (error: Exception) {
      restoreBestEffort(targetContext, prior)
      throw error
    }
    if (!committed) {
      // commit() false can leave the in-memory value mutated; restore the
      // exact prior key before failing so setup never leaks fixture state.
      restoreBestEffort(targetContext, prior)
      throw IllegalStateException("Failed to set debug server host")
    }
    return prior
  }

  fun restore(targetContext: Context, prior: Prior) {
    val prefs = PreferenceManager.getDefaultSharedPreferences(targetContext)
    val editor = if (prior.hadKey) {
      val priorValue = prior.value
      check(priorValue != null) { "Prior must hold a String when present" }
      prefs.edit().putString(DEBUG_SERVER_HOST_KEY, priorValue)
    } else {
      check(prior.value == null) { "Prior must hold absence when not present" }
      prefs.edit().remove(DEBUG_SERVER_HOST_KEY)
    }
    check(editor.commit()) { "Failed to restore debug server host" }
  }

  private fun restoreBestEffort(targetContext: Context, prior: Prior) {
    try {
      restore(targetContext, prior)
    } catch (_: Exception) {
    }
  }
}
