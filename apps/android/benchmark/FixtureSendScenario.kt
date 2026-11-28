package dev.ace.android.benchmark

import android.app.Instrumentation
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo

// Bounded debug-only functional scenario: open the real inbox stream thread,
// type into the real composer with normal input injection, tap send once and
// assert the composer cleared. Host tooling checks canonical admission
// separately. Uses only platform Instrumentation/UiAutomation/
// AccessibilityNodeInfo APIs already in the SDK. No UIAutomator dependency.
// Never logs message contents; bundles carry lengths and counts only.
object FixtureSendScenario {
  const val SCENARIO_NAME = "fixture-send"
  const val THREAD_TITLE = "ace CLI phase 2"
  const val COMPOSER_DESCRIPTION = "Message"
  const val COMPOSER_HINT = "Steer the agent…"
  const val SEND_DESCRIPTION = "\u2191"
  const val MAX_DURATION_MS = 90_000L
  private const val POLL_MS = 500L
  private const val FIRST_TYPE_WAIT_MS = 15_000L
  private const val MAX_PROBE_LENGTH = 200
  private val PROBE_PATTERN = Regex("^[ -~]{1,200}$")

  // Device contract: probe text is ASCII printable, max 200 chars. Wider
  // observer/storage caps (e.g. 512) remain fine; the host driver must choose
  // a probe within this 200-char device bound. No latency claims here.
  fun validateProbeText(raw: String?): String {
    require(!raw.isNullOrEmpty()) { "probeText must be supplied" }
    require(raw.length <= MAX_PROBE_LENGTH) { "probeText exceeds 200 characters" }
    require(!raw.isBlank()) { "probeText must not be blank" }
    require(PROBE_PATTERN.matches(raw)) { "probeText must be ASCII printable" }
    return raw
  }

  fun run(instrumentation: Instrumentation, rawProbeText: String?): Bundle {
    val probeText = validateProbeText(rawProbeText)
    val deadline = SystemClock.uptimeMillis() + MAX_DURATION_MS
    val automation = instrumentation.uiAutomation
      ?: throw IllegalStateException("UiAutomation is unavailable")

    openThread(automation, deadline)
    val composer = awaitNode(automation, deadline, "composer") { isComposer(it) }
      ?: throw IllegalStateException("Composer was not found")
    try {
      // Never overwrite user data: refuse a pre-existing non-empty draft.
      // A platform-reported placeholder (showing hint) does not count as a draft.
      check(draftText(composer).isNullOrEmpty()) { "Composer is not empty" }
      typeText(instrumentation, automation, composer, probeText, deadline)
    } finally {
      recycleQuietly(composer)
    }
    val sendClicks = tapSendOnce(automation, deadline)
    check(sendClicks == 1) { "Send was not tapped exactly once" }
    assertComposerCleared(automation, deadline)

    return Bundle().apply {
      putString("scenario", SCENARIO_NAME)
      putString("fixtureSend", "passed")
      putInt("probeLength", probeText.length)
      putInt("sendClicks", sendClicks)
    }
  }

  private fun openThread(
    automation: android.app.UiAutomation,
    deadline: Long,
  ) {
    val row = awaitNode(automation, deadline, "inbox-row") { node ->
      node.text?.toString() == THREAD_TITLE
    } ?: throw IllegalStateException("Inbox thread was not found")
    try {
      check(clickClosestClickable(row)) { "Inbox thread could not be opened" }
    } finally {
      recycleQuietly(row)
    }
    // Wait until the thread surface shows the composer.
    val composer = awaitNode(automation, deadline, "thread-composer") { isComposer(it) }
      ?: throw IllegalStateException("Thread did not open")
    recycleQuietly(composer)
  }

  private fun typeText(
    instrumentation: Instrumentation,
    automation: android.app.UiAutomation,
    composer: AccessibilityNodeInfo,
    probeText: String,
    deadline: Long,
  ) {
    composer.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
    clickClosestClickable(composer)
    instrumentation.sendStringSync(probeText)
    // Bounded first wait within the remaining overall budget so the single
    // set-text fallback below stays reachable; send exactly once either way.
    val firstEnd = minOf(deadline, SystemClock.uptimeMillis() + FIRST_TYPE_WAIT_MS)
    if (awaitText(automation, firstEnd, probeText)) return
    // Fallback through the same node via an accessibility set-text action.
    val fresh = awaitNode(automation, deadline, "composer-retry") { isComposer(it) }
      ?: throw IllegalStateException("Composer was lost before typing")
    try {
      val args = Bundle().apply {
        putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, probeText)
      }
      check(fresh.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
        "Composer input was rejected"
      }
    } finally {
      recycleQuietly(fresh)
    }
    check(awaitText(automation, deadline, probeText)) { "Composer did not show the input" }
  }

  private fun tapSendOnce(
    automation: android.app.UiAutomation,
    deadline: Long,
  ): Int {
    // The arrow label may live on a non-clickable text child or a merged
    // semantics node; climb to the clickable ancestor and tap exactly once.
    val label = awaitNode(automation, deadline, "send") { isSendLabel(it) }
      ?: throw IllegalStateException("Send control was not found")
    try {
      val target = if (label.isClickable) label else findClickableAncestor(label)
        ?: throw IllegalStateException("Send has no tappable ancestor")
      try {
        check(target.isEnabled) { "Send was not enabled" }
        val bounds = Rect()
        target.getBoundsInScreen(bounds)
        check(!bounds.isEmpty) { "Send has no tappable bounds" }
        check(target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
          "Send could not be tapped"
        }
        return 1
      } finally {
        if (target !== label) recycleQuietly(target)
      }
    } finally {
      recycleQuietly(label)
    }
  }

  private fun assertComposerCleared(
    automation: android.app.UiAutomation,
    deadline: Long,
  ) {
    check(deadline > SystemClock.uptimeMillis()) { "Composer clear check timed out" }
    while (SystemClock.uptimeMillis() < deadline) {
      val root = automation.rootInActiveWindow
      if (root != null) {
        try {
          val match = searchOnce(root, ::isComposer)
          if (match != null) {
            try {
              if (draftText(match).isNullOrEmpty()) return
            } finally {
              if (match !== root) recycleQuietly(match)
            }
          }
        } finally {
          recycleQuietly(root)
        }
      }
      SystemClock.sleep(POLL_MS)
    }
    throw IllegalStateException("Composer did not clear after send")
  }

  private fun awaitText(
    automation: android.app.UiAutomation,
    deadline: Long,
    expected: String,
  ): Boolean {
    while (SystemClock.uptimeMillis() < deadline) {
      val root = automation.rootInActiveWindow
      if (root != null) {
        try {
          val match = searchOnce(root) { node ->
            isComposer(node) && node.text?.toString() == expected
          }
          if (match != null) {
            if (match !== root) recycleQuietly(match)
            return true
          }
        } finally {
          recycleQuietly(root)
        }
      }
      SystemClock.sleep(POLL_MS)
    }
    return false
  }

  private fun awaitNode(
    automation: android.app.UiAutomation,
    deadline: Long,
    stage: String,
    predicate: (AccessibilityNodeInfo) -> Boolean,
  ): AccessibilityNodeInfo? {
    check(deadline > SystemClock.uptimeMillis()) { "$stage wait already expired" }
    while (SystemClock.uptimeMillis() < deadline) {
      val root = automation.rootInActiveWindow
      if (root != null) {
        val match = searchOnce(root, predicate)
        if (match != null) {
          // Caller owns the match; the tree root is no longer needed.
          if (match !== root) recycleQuietly(root)
          return match
        }
        recycleQuietly(root)
      }
      SystemClock.sleep(POLL_MS)
    }
    return null
  }

  private fun isComposer(node: AccessibilityNodeInfo): Boolean {
    val description = node.contentDescription?.toString().orEmpty()
    val hint = if (Build.VERSION.SDK_INT >= 26) {
      try {
        node.hintText?.toString().orEmpty()
      } catch (_: Exception) {
        ""
      }
    } else {
      ""
    }
    val className = node.className?.toString().orEmpty()
    val labelled = description == COMPOSER_DESCRIPTION || description.contains(COMPOSER_DESCRIPTION)
    val hinted = hint == COMPOSER_HINT
    val editable = node.isEditable || className.contains("EditText")
    return (labelled || hinted) && (editable || node.text != null)
  }

  private fun isSendLabel(node: AccessibilityNodeInfo): Boolean {
    return node.contentDescription?.toString() == SEND_DESCRIPTION ||
      node.text?.toString() == SEND_DESCRIPTION
  }

  // Hint-aware draft readout: only a platform-reported placeholder is empty.
  // Never treats real text equal to the hint string as empty. On API 26+ rely
  // on isShowingHintText; on older APIs (or unreadable hint state) treat any
  // nonempty text as a draft so setup refuses rather than overwriting.
  private fun draftText(node: AccessibilityNodeInfo): String? {
    val text = node.text?.toString()
    if (text.isNullOrEmpty()) return null
    if (Build.VERSION.SDK_INT >= 26) {
      try {
        return if (node.isShowingHintText) null else text
      } catch (_: Exception) {
        return text
      }
    }
    return text
  }

  private fun findClickableAncestor(start: AccessibilityNodeInfo): AccessibilityNodeInfo? {
    var parent: AccessibilityNodeInfo? = start.parent
    while (parent != null) {
      val up = parent.parent
      if (parent.isClickable) {
        if (up != null && up !== parent) recycleQuietly(up)
        return parent
      }
      recycleQuietly(parent)
      parent = up
    }
    return null
  }

  private fun clickClosestClickable(start: AccessibilityNodeInfo): Boolean {
    if (start.isClickable) {
      val bounds = Rect()
      start.getBoundsInScreen(bounds)
      if (bounds.isEmpty) return false
      return start.performAction(AccessibilityNodeInfo.ACTION_CLICK)
    }
    var parent: AccessibilityNodeInfo? = start.parent
    while (parent != null) {
      val up = parent.parent
      val clickable = parent.isClickable
      if (clickable) {
        val bounds = Rect()
        parent.getBoundsInScreen(bounds)
        val empty = bounds.isEmpty
        val clicked = if (!empty) parent.performAction(AccessibilityNodeInfo.ACTION_CLICK) else false
        recycleQuietly(parent)
        if (up != null && up !== parent) recycleQuietly(up)
        return clicked
      }
      recycleQuietly(parent)
      parent = up
    }
    return false
  }

  private fun searchOnce(
    root: AccessibilityNodeInfo,
    predicate: (AccessibilityNodeInfo) -> Boolean,
  ): AccessibilityNodeInfo? {
    if (predicate(root)) return root
    val queue = ArrayDeque<AccessibilityNodeInfo>()
    for (i in 0 until root.childCount) {
      root.getChild(i)?.let { queue.add(it) }
    }
    while (queue.isNotEmpty()) {
      val node = queue.removeFirst()
      var matched = false
      try {
        matched = predicate(node)
      } catch (_: Exception) {
        matched = false
      }
      if (matched) {
        while (queue.isNotEmpty()) recycleQuietly(queue.removeFirst())
        return node
      }
      for (i in 0 until node.childCount) {
        node.getChild(i)?.let { queue.add(it) }
      }
      recycleQuietly(node)
    }
    return null
  }

  private fun recycleQuietly(node: AccessibilityNodeInfo?) {
    try {
      node?.recycle()
    } catch (_: Exception) {
    }
  }
}
