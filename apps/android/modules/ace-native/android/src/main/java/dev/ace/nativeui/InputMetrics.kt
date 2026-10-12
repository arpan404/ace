package dev.ace.nativeui

import android.content.Context
import android.graphics.Paint
import android.graphics.Typeface
import java.security.MessageDigest
import java.util.Locale
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.view.Choreographer
import android.view.FrameMetrics
import android.view.ViewTreeObserver
import android.view.Window
import android.widget.EditText

// Android input enqueue timestamp -> JS editing-state commit -> completed rendering frame.
class InputMetrics {
  private var view: EditText? = null
  private var window: Window? = null
  private var completion: java.util.concurrent.CountDownLatch? = null
  private var eventNs = 0L
  private var mutated = false
  private var committed = false
  private var currentVsyncNs = 0L
  private val tick = object : Choreographer.FrameCallback {
    override fun doFrame(frameTimeNanos: Long) {
      currentVsyncNs = frameTimeNanos
      if (view != null) Choreographer.getInstance().postFrameCallback(this)
    }
  }
  private var drawVsyncNs = 0L
  private val samples = ArrayDeque<Double>()
  private var keys = 0
  private var mutations = 0
  private var commits = 0
  private var draws = 0
  private val watcher = object : TextWatcher {
    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
      if (eventNs > 0 && count > 0) { mutated = true; mutations++ }
    }
    override fun afterTextChanged(s: Editable?) {}
  }
  private val draw = ViewTreeObserver.OnDrawListener {
    if (eventNs > 0 && mutated && committed && drawVsyncNs == 0L) {
      drawVsyncNs = currentVsyncNs
      draws++
    }
  }
  private val frame = Window.OnFrameMetricsAvailableListener { _, metrics, _ ->
    if (drawVsyncNs > 0 && metrics.getMetric(FrameMetrics.VSYNC_TIMESTAMP) == drawVsyncNs) {
      val completed = drawVsyncNs + metrics.getMetric(FrameMetrics.TOTAL_DURATION)
      val latency = (completed - eventNs) / 1_000_000.0
      if (latency >= 0) {
        if (samples.size == 256) samples.removeFirst()
        samples.addLast(latency)
        if (samples.size % 20 == 0) android.util.Log.i("AceSpikeInput", org.json.JSONObject(summary()).toString())
      }
      completion?.countDown()
      completion = null
      resetEvent()
    }
  }
  fun attach(next: EditText, targetWindow: Window) {
    close()
    view = next
    window = targetWindow
    samples.clear()
    keys = 0
    mutations = 0
    commits = 0
    draws = 0
    Choreographer.getInstance().postFrameCallback(tick)
    next.addTextChangedListener(watcher)
    next.viewTreeObserver.addOnDrawListener(draw)
    targetWindow.addOnFrameMetricsAvailableListener(frame, Handler(Looper.getMainLooper()))
    android.util.Log.i("AceSpikeFont", org.json.JSONObject(fontEvidence(next.context)).toString())
  }
  fun resetSamples() {
    check(view?.hasFocus() == true) { "Focus the composer before probing input" }
    samples.clear()
    keys = 0
    mutations = 0
    commits = 0
    draws = 0
    resetEvent()
  }
  fun beginInput(timeMs: Long, finished: java.util.concurrent.CountDownLatch) {
    check(view?.hasFocus() == true) { "Composer focus was lost" }
    resetEvent()
    eventNs = timeMs * 1_000_000
    keys++
    completion = finished
  }
  fun finishInput(finished: java.util.concurrent.CountDownLatch) {
    if (completion === finished) {
      completion = null
      resetEvent()
    }
  }
  fun commit(textLength: Int) {
    if (eventNs > 0 && mutated && view?.text?.length == textLength) {
      committed = true
      commits++
      view?.invalidate()
    }
  }
  fun summary(): Map<String, Any> {
    val sorted = samples.sorted()
    val p95 = if (sorted.isEmpty()) 0.0 else sorted[kotlin.math.ceil(sorted.size * 0.95).toInt() - 1]
    val allAttemptRank = kotlin.math.ceil(keys * 0.95).toInt() - 1
    // Uncaptured attempts are censored at the 2-second capture timeout.
    val allAttemptP95 = sorted.getOrNull(allAttemptRank) ?: if (keys == 0) 0.0 else 2000.0
    return mapOf("misses" to (keys - sorted.size),
      "coverage" to (if (keys == 0) 0.0 else sorted.size.toDouble() / keys),
      "minimumCoverage" to 0.95, "allAttemptP95LowerBoundMs" to allAttemptP95, "samples" to sorted.size, "p95Ms" to p95, "maxMs" to (sorted.lastOrNull() ?: 0.0),
      "keys" to keys, "mutations" to mutations, "commits" to commits, "draws" to draws)
  }
  fun fontEvidence(context: Context): Map<String, Any> {
    val input = view ?: throw IllegalStateException("Focus the composer before reading font evidence")
    val sample = "ace Queue 012345"
    val expected = Paint(input.paint)
    expected.typeface = Typeface.createFromAsset(context.assets, "fonts/Inter.ttf")
    val bytes = context.assets.open("fonts/Inter.ttf").use { it.readBytes() }
    val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    return mapOf("assetSha256" to hash, "actualAdvance" to input.paint.measureText(sample).toDouble(),
      "bundledAdvance" to expected.measureText(sample).toDouble(),
      "foreground" to String.format(Locale.ROOT, "#%06X", input.currentTextColor and 0xffffff),
      "textSizePx" to input.textSize.toDouble())
  }
  private fun resetEvent() {
    eventNs = 0
    mutated = false
    committed = false
    drawVsyncNs = 0
  }
  fun close() {
    Choreographer.getInstance().removeFrameCallback(tick)
    view?.removeTextChangedListener(watcher)
    view?.viewTreeObserver?.takeIf { it.isAlive }?.removeOnDrawListener(draw)
    window?.removeOnFrameMetricsAvailableListener(frame)
    completion?.countDown()
    completion = null
    view = null
    window = null
    resetEvent()
  }
}
