package dev.ace.nativeui

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.ui.ExpoUIView
import android.widget.EditText
import expo.modules.kotlin.functions.Queues

class AceNativeModule : Module() {
  private val metrics = InputMetrics()
  override fun definition() = ModuleDefinition {
    Name("AceNative")
    AsyncFunction("watchInput") { tag: Int ->
      val view = appContext.findView<EditText>(tag) ?: throw IllegalArgumentException("Input is unavailable")
      metrics.attach(view)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("inputMetrics") { metrics.summary() }.runOnQueue(Queues.MAIN)
    AsyncFunction("stopInputMetrics") { metrics.close() }.runOnQueue(Queues.MAIN)
    OnDestroy { metrics.close() }
    ExpoUIView<AceThemeProps>("AceTheme") {
      Content { props -> AceThemeContent(props) }
    }
  }
}
