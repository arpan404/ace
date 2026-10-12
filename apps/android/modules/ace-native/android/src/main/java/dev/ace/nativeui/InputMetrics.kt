package dev.ace.nativeui

import android.text.Editable
import android.text.TextWatcher
import android.view.ViewTreeObserver
import android.widget.EditText

// Native text mutation to the draw containing the new value. No JS echo or IPC time is hidden.
// This is a spike diagnostic, not a claim about physical keyboard-to-photon latency.
class InputMetrics {
  private var view: EditText? = null
  private var start = 0L
  private var dirty = false
  private val samples = ArrayDeque<Double>()
  private val watcher = object : TextWatcher {
    override fun beforeTextChanged(s: CharSequence?, offset: Int, count: Int, after: Int) {
      if (after > 0 && !dirty) start = System.nanoTime()
    }
    override fun onTextChanged(s: CharSequence?, offset: Int, before: Int, count: Int) {
      if (count > 0) dirty = true
    }
    override fun afterTextChanged(s: Editable?) {}
  }
  private val draw = ViewTreeObserver.OnDrawListener {
    if (dirty && start > 0) {
      if (samples.size == 256) samples.removeFirst()
      samples.addLast((System.nanoTime() - start) / 1_000_000.0)
      dirty = false
      start = 0
    }
  }
  fun attach(next: EditText) {
    close()
    view = next
    samples.clear()
    next.addTextChangedListener(watcher)
    next.viewTreeObserver.addOnDrawListener(draw)
  }
  fun summary(): Map<String, Any> {
    val sorted = samples.sorted()
    val p95 = if (sorted.isEmpty()) 0.0 else sorted[(kotlin.math.ceil(sorted.size * 0.95).toInt() - 1).coerceAtLeast(0)]
    return mapOf("samples" to sorted.size, "p95Ms" to p95, "maxMs" to (sorted.lastOrNull() ?: 0.0))
  }
  fun close() {
    view?.removeTextChangedListener(watcher)
    view?.viewTreeObserver?.takeIf { it.isAlive }?.removeOnDrawListener(draw)
    view = null
    dirty = false
    start = 0
  }
}
