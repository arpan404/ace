package dev.ace.nativeui

import android.app.Activity
import android.app.Instrumentation
import android.content.pm.ApplicationInfo
import android.os.SystemClock
import android.view.KeyEvent
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

// Debug-only input injection into this app. The timestamp precedes InputManager enqueue,
// IME processing, React editing-state commit and completed rendering. No text is logged.
class InputProbe(private val metrics: InputMetrics) {
  private val active = AtomicBoolean(false)

  fun run(activity: Activity, count: Int): Map<String, Any> {
    check(activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
      "Input probing is unavailable in release builds"
    }
    require(count in 1..120)
    check(active.compareAndSet(false, true)) { "An input probe is already running" }
    try {
      main(activity) { metrics.resetSamples() }
      val instrumentation = Instrumentation()
      repeat(count) {
        val finished = CountDownLatch(1)
        val down = main(activity) {
          check(activity.hasWindowFocus()) { "The app lost window focus" }
          val time = SystemClock.uptimeMillis()
          metrics.beginInput(time, finished)
          KeyEvent(time, time, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_A, 0)
        }
        instrumentation.sendKeySync(down)
        instrumentation.sendKeySync(KeyEvent.changeAction(down, KeyEvent.ACTION_UP))
        check(finished.await(2, TimeUnit.SECONDS)) { "A completed input frame was not captured" }
        Thread.sleep(200)
      }
      val result = main(activity) { metrics.summary() }
      check(result["samples"] == count) { "Input coverage was incomplete" }
      return result
    } finally {
      active.set(false)
    }
  }

  private fun <T : Any> main(activity: Activity, action: () -> T): T {
    val done = CountDownLatch(1)
    val value = AtomicReference<T>()
    val failure = AtomicReference<Throwable>()
    activity.runOnUiThread {
      try { value.set(action()) } catch (error: Throwable) { failure.set(error) }
      finally { done.countDown() }
    }
    check(done.await(5, TimeUnit.SECONDS)) { "The UI thread did not respond" }
    failure.get()?.let { throw it }
    return value.get() ?: throw IllegalStateException("The UI result was unavailable")
  }
}
