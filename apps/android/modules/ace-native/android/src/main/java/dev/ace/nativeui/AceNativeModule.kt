package dev.ace.nativeui

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.ui.ExpoUIView

class AceNativeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AceNative")
    Function("getExecutionMode") { BuildConfig.ACE_EXECUTION_MODE }
    installInputHooks(appContext)
    ExpoUIView<AceThemeProps>("AceTheme") {
      Content { props -> AceThemeContent(props) }
    }
  }
}
