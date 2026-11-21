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
  private var scenario: String? = null
  private var probeText: String? = null
  override fun onCreate(arguments: Bundle?) {
    super.onCreate(arguments)
    durationSeconds = arguments?.getString("durationSeconds")?.toIntOrNull()?.coerceIn(60, 600) ?: 600
    scenario = arguments?.getString("scenario")
    probeText = arguments?.getString("probeText")
    start()
  }
  override fun onStart() {
    val result = Bundle()
    try {
      check(targetContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
      if (scenario != null && scenario != FixtureSendScenario.SCENARIO_NAME) {
        result.putString("scenario", scenario)
        result.putString("fixtureSend", "failed")
        result.putString("error", "IllegalArgumentException")
        finish(Activity.RESULT_CANCELED, result)
        return
      }
      if (scenario == FixtureSendScenario.SCENARIO_NAME) {
        val probe = FixtureSendScenario.validateProbeText(probeText)
        var passed = false
        var probeLength = 0
        var sendClicks = 0
        var errorName: String? = null
        val prior = FixtureDevServer.configure(targetContext)
        try {
          val name = targetContext.packageName
          startActivitySync(Intent(Intent.ACTION_MAIN).setClassName(name, "$name.MainActivity")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
          val metadata = FixtureSendScenario.run(this, probe)
          probeLength = metadata.getInt("probeLength", 0)
          sendClicks = metadata.getInt("sendClicks", 0)
          passed = true
        } catch (error: Exception) {
          errorName = error.javaClass.simpleName
        } finally {
          FixtureDevServer.restore(targetContext, prior)
        }
        if (passed) {
          result.putString("scenario", FixtureSendScenario.SCENARIO_NAME)
          result.putString("fixtureSend", "passed")
          result.putInt("probeLength", probeLength)
          result.putInt("sendClicks", sendClicks)
          finish(Activity.RESULT_OK, result)
        } else {
          result.putString("scenario", FixtureSendScenario.SCENARIO_NAME)
          result.putString("fixtureSend", "failed")
          result.putString("error", errorName)
          finish(Activity.RESULT_CANCELED, result)
        }
        return
      }
      val name = targetContext.packageName
      startActivitySync(Intent(Intent.ACTION_MAIN).setClassName(name, "$name.MainActivity")
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      val deadline = SystemClock.uptimeMillis() + durationSeconds * 1000L
      while (SystemClock.uptimeMillis() < deadline) Thread.sleep(1000)
      result.putString("benchmark", "Instrumentation window completed")
      finish(Activity.RESULT_OK, result)
    } catch (error: Exception) {
      if (scenario != null) {
        result.putString("scenario", scenario)
        result.putString("fixtureSend", "failed")
        result.putString("error", error.javaClass.simpleName)
      } else {
        result.putString("benchmark", error.javaClass.simpleName)
      }
      finish(Activity.RESULT_CANCELED, result)
    }
  }
}
