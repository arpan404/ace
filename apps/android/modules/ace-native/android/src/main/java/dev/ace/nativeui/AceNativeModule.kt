package dev.ace.nativeui

import android.app.Activity
import android.app.Application
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.os.Looper
import android.util.Base64
import android.view.WindowManager
import dev.ace.nativeui.transport.PinnedHttpClient
import dev.ace.nativeui.transport.PinnedHttpFailure
import dev.ace.nativeui.transport.PinnedSocket
import dev.ace.nativeui.transport.PinnedSocketRegistry
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import expo.modules.ui.ExpoUIView

class AceNativeModule : Module() {
  // Identity-keyed: a stale onClose from a replaced socket must never evict
  // its replacement (which would leak the replacement: dropped from the map
  // but never closed). See PinnedSocketRegistry.
  private val sockets = PinnedSocketRegistry<PinnedSocket>()

  override fun definition() = ModuleDefinition {
    Name("AceNative")
    Function("getExecutionMode") { BuildConfig.ACE_EXECUTION_MODE }
    // Clipboard write for transcript code blocks (A05.02): copies plain text
    // via the system ClipboardManager. Returns true when the text was placed;
    // false when there is no context to copy with. Never throws to JS.
    Function("copyText") { text: String ->
      try {
        val context = appContext.reactContext ?: appContext.currentActivity
        val manager = context?.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        if (manager == null) return@Function false
        manager.setPrimaryClip(ClipData.newPlainText("ace-code", text))
        true
      } catch (_: Exception) {
        false
      }
    }
    // Recents guard, runtime layer. The first-frame guarantee lives in
    // MainActivity.onCreate (see plugins/with-ace-secure-screen.ts), which runs
    // at actual Activity creation before the Expo module exists. These
    // callbacks re-apply the desired state to every Activity on
    // creation/start/resume, covering recreation (rotation, process restart)
    // and Activities other than MainActivity. The desired state survives
    // Activity turnover in SecureScreenGuard.
    var secureCallbacks: Application.ActivityLifecycleCallbacks? = null
    fun registerSecureCallbacks(app: Application?) {
      if (secureCallbacks != null || app == null) return
      val listener =
        object : Application.ActivityLifecycleCallbacks {
          override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
            SecureScreenGuard.applyTo(activity)
          }
          override fun onActivityStarted(activity: Activity) {
            SecureScreenGuard.applyTo(activity)
          }
          override fun onActivityResumed(activity: Activity) {
            SecureScreenGuard.applyTo(activity)
          }
          override fun onActivityPaused(activity: Activity) = Unit
          override fun onActivityStopped(activity: Activity) = Unit
          override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
          override fun onActivityDestroyed(activity: Activity) = Unit
        }
      try {
        app.registerActivityLifecycleCallbacks(listener)
        secureCallbacks = listener
      } catch (_: Exception) {
        // Registration failure must not crash the module: the desired state
        // stays fail-closed (secure) and setSecureScreen retries below, so a
        // later Activity still picks it up.
      }
    }
    fun currentApplication(): Application? =
      (appContext.reactContext?.applicationContext as? Application)
        ?: appContext.currentActivity?.application
    OnCreate {
      SecureScreenGuard.desiredSecure = true
      registerSecureCallbacks(currentApplication())
      appContext.currentActivity?.let { activity ->
        activity.runOnUiThread { SecureScreenGuard.applyTo(activity) }
      }
    }
    OnDestroy {
      secureCallbacks?.let { listener ->
        try {
          currentApplication()?.unregisterActivityLifecycleCallbacks(listener)
        } catch (_: Exception) {
          // Best-effort teardown only.
        } finally {
          secureCallbacks = null
        }
      }
    }
    // Recents/screenshot guard for the app lock. FLAG_SECURE blanks the window
    // in the switcher and blocks screenshots while set; it never takes effect
    // on JS timing because the OS excludes the window at composition time.
    // Returns true only when an activity existed to apply to (applied inline
    // when already on the UI thread, otherwise dispatched to it). A null
    // activity returns false (never a silent success): the fail-closed
    // defaults above still cover not-yet-created activities, and the desired
    // state is kept so the next created activity picks it up.
    Function("setSecureScreen") { enabled: Boolean ->
      SecureScreenGuard.desiredSecure = enabled
      // A failed or deferred registration above (null Application at OnCreate)
      // is retried here, so a later Activity still gets the guard.
      registerSecureCallbacks(currentApplication())
      val activity = appContext.currentActivity ?: return@Function false
      if (Looper.myLooper() == Looper.getMainLooper()) {
        SecureScreenGuard.applyTo(activity)
      } else {
        activity.runOnUiThread { SecureScreenGuard.applyTo(activity) }
      }
      true
    }
    installInputHooks(appContext)
    ExpoUIView<AceThemeProps>("AceTheme") {
      Content { props -> AceThemeContent(props) }
    }

    Events("onPinnedSocketEvent")

    /**
     * Secure-window verification for the production entry. The single
     * `with-ace-secure-screen` config plugin sets FLAG_SECURE on the Activity
     * window before the first frame; `SecureScreenGuard` re-applies it across
     * recreation. This check only verifies the native flag: false (or a
     * missing Activity) fails the production root closed before any
     * directory read or socket connect.
     */
    Function("secureWindowApplied") {
      val flags = appContext.currentActivity?.window?.attributes?.flags ?: return@Function false
      (flags and WindowManager.LayoutParams.FLAG_SECURE) != 0
    }

    /**
     * One pinned HTTPS request. Resolves `{status, body}`; rejects with an
     * error whose message is exactly the refusal (`pin`, `redirect`,
     * `offline`, `limit` or `invalid`). The pin and validity window are
     * verified during the TLS handshake before the request is written, so a
     * mismatched pin never sends the code, token or ticket.
     */
    AsyncFunction("pinnedFetch") {
        origin: String,
        fingerprint: String,
        method: String,
        path: String,
        body: String?,
        token: String?,
        promise: Promise ->
      Thread {
        try {
          val response = PinnedHttpClient(origin, fingerprint).execute(method, path, body, token)
          promise.resolve(mapOf("status" to response.status, "body" to response.body))
        } catch (e: PinnedHttpFailure) {
          promise.reject(e.reason, e.reason, e)
        } catch (e: Exception) {
          promise.reject("offline", "offline", e)
        }
      }.apply { isDaemon = true }.start()
    }

    /**
     * Pinned WSS transport. Events arrive as `onPinnedSocketEvent` with
     * `{id, type, value}` where type is `open`, `message`, `binary`
     * (base64), `trust` or `close` (numeric code as text), matching iOS.
     */
    Function("pinnedSocketOpen") { id: String, url: String, fingerprint: String ->
      val bridge = SocketBridge(id)
      val socket =
        PinnedSocket(url, fingerprint, System::currentTimeMillis, bridge)
      bridge.attach(socket)
      val previous = sockets.replace(id, socket)
      try {
        previous?.close()
      } catch (e: Exception) {
        // Closing an already-gone socket is a no-op.
      }
      socket.open()
      true
    }
    Function("pinnedSocketSend") { id: String, text: String ->
      sockets.current(id)?.send(text)
      true
    }
    Function("pinnedSocketClose") { id: String ->
      closeSocket(id)
      true
    }
  }

  private fun closeSocket(id: String) {
    try {
      sockets.take(id)?.close()
    } catch (e: Exception) {
      // Closing an already-gone socket is a no-op.
    }
  }

  private inner class SocketBridge(private val id: String) : PinnedSocket.SocketEvents {
    private var socket: PinnedSocket? = null

    fun attach(socket: PinnedSocket) {
      this.socket = socket
    }

    /**
     * Stale events from a replaced socket are dropped: after a reopen the id
     * names the replacement, so emitting the old socket's frames under it
     * would misattribute another session's bytes.
     */
    private fun isCurrent(): Boolean {
      val attached = socket
      return attached != null && sockets.isCurrent(id, attached)
    }

    override fun onOpen() {
      if (!isCurrent()) return
      sendEvent("onPinnedSocketEvent", mapOf("id" to id, "type" to "open", "value" to ""))
    }
    override fun onMessage(text: String) {
      if (!isCurrent()) return
      sendEvent("onPinnedSocketEvent", mapOf("id" to id, "type" to "message", "value" to text))
    }
    override fun onBinary(bytes: ByteArray) {
      if (!isCurrent()) return
      val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
      sendEvent("onPinnedSocketEvent", mapOf("id" to id, "type" to "binary", "value" to base64))
    }
    override fun onTrust(reason: String) {
      if (!isCurrent()) return
      sendEvent("onPinnedSocketEvent", mapOf("id" to id, "type" to "trust", "value" to reason))
    }
    override fun onClose(code: Int) {
      val attached = socket
      if (attached == null || !sockets.removeIfCurrent(id, attached)) {
        // Stale close from a replaced socket: the id now names the
        // replacement, which stays open and owned by the map. Emitting here
        // would tell JS the new socket died while leaking it.
        return
      }
      sendEvent(
        "onPinnedSocketEvent",
        mapOf("id" to id, "type" to "close", "value" to code.toString()),
      )
    }
  }
}
