package dev.ace.nativeui

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.ui.ExpoUIView
import android.widget.EditText
import expo.modules.kotlin.functions.Queues

class AceNativeModule : Module() {
  private val metrics = InputMetrics()
  private val probe = InputProbe(metrics)
  override fun definition() = ModuleDefinition {
    Name("AceNative")
    AsyncFunction("watchInput") { tag: Int ->
      val view = appContext.findView<EditText>(tag) ?: throw IllegalArgumentException("Input is unavailable")
      val window = appContext.currentActivity?.window ?: throw IllegalStateException("Window is unavailable")
      metrics.attach(view, window)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("commitInput") { length: Int -> metrics.commit(length) }.runOnQueue(Queues.MAIN)
    AsyncFunction("inputMetrics") { metrics.summary() }.runOnQueue(Queues.MAIN)
    AsyncFunction("probeInput") { count: Int ->
      probe.run(appContext.currentActivity ?: throw IllegalStateException("Activity is unavailable"), count)
    }
    AsyncFunction("fontEvidence") { metrics.fontEvidence(appContext.reactContext ?: throw IllegalStateException("React is unavailable")) }.runOnQueue(Queues.MAIN)
    AsyncFunction("stopInputMetrics") { metrics.close() }.runOnQueue(Queues.MAIN)
    OnDestroy { appContext.currentActivity?.runOnUiThread { metrics.close() } }
    ExpoUIView<AceThemeProps>("AceTheme") {
      Content { props -> AceThemeContent(props) }
    }
  }
}
