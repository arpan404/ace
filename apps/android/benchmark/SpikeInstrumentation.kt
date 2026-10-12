package dev.ace.android.benchmark

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.os.SystemClock

// A separate, debug-only test APK starts this runner from adb. Android then attributes
// input injection to the shell instrumentation source. The product APK gains no permission.
class SpikeInstrumentation : Instrumentation() {
  private var durationSeconds = 600
  override fun onCreate(arguments: Bundle?) {
    super.onCreate(arguments)
    durationSeconds = arguments?.getString("durationSeconds")?.toIntOrNull()?.coerceIn(60, 600) ?: 600
    start()
  }
  override fun onStart() {
    val result = Bundle()
    try {
      check(targetContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
      val name = targetContext.packageName
      startActivitySync(Intent(Intent.ACTION_MAIN).setClassName(name, "$name.MainActivity")
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      val deadline = SystemClock.uptimeMillis() + durationSeconds * 1000L
      while (SystemClock.uptimeMillis() < deadline) Thread.sleep(1000)
      result.putString("benchmark", "Instrumentation window completed")
      finish(Activity.RESULT_OK, result)
    } catch (error: Exception) {
      result.putString("benchmark", error.javaClass.simpleName)
      finish(Activity.RESULT_CANCELED, result)
    }
  }
}
