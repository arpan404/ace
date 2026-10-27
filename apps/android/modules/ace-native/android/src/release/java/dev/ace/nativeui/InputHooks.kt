package dev.ace.nativeui

import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.ModuleDefinitionBuilder

/** Production registers no input hooks; the probe and metrics classes are absent from this build. */
fun ModuleDefinitionBuilder.installInputHooks(appContext: AppContext) {
  check(BuildConfig.ACE_EXECUTION_MODE == "production") {
    "The release hooks must only compile into the production build"
  }
}
