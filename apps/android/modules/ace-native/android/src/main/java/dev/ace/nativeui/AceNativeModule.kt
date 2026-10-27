package dev.ace.nativeui

import android.util.Base64
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
    installInputHooks(appContext)
    ExpoUIView<AceThemeProps>("AceTheme") {
      Content { props -> AceThemeContent(props) }
    }

    Events("onPinnedSocketEvent")

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
