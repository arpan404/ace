package dev.ace.nativeui.transport

import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLContext
import okhttp3.ConnectionSpec
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

/**
 * A native pinned socket mirroring iOS `PinnedSocket`: WSS whose server must
 * present the pinned public key, validated before the SDK sees `open`.
 * Redirects are refused (OkHttp never follows them for WebSockets), binary
 * messages within the 2 MiB cap reach the SDK, oversized frames close the
 * socket, and a pin refusal reports `trust("pin")` before the fatal close so
 * callers can tell it apart from a revoked device. There is no unpinned
 * fallback: after any failure the socket stays closed.
 *
 * Blocking I/O and callbacks run on OkHttp's dispatcher, never the main
 * thread. The owner must call [close]; it shuts the dispatcher's executor.
 */
class PinnedSocket(
  private val url: String,
  private val fingerprint: String,
  private val nowMs: () -> Long = System::currentTimeMillis,
  private val events: SocketEvents,
) {
  interface SocketEvents {
    fun onOpen()
    fun onMessage(text: String)
    fun onBinary(bytes: ByteArray)
    fun onTrust(reason: String)
    fun onClose(code: Int)
  }

  private val ended = AtomicBoolean(false)
  private var socket: WebSocket? = null
  private var client: OkHttpClient? = null

  fun open() {
    val endpoint =
      try {
        validateSocketTarget(url, fingerprint)
      } catch (e: PinnedHttpFailure) {
        finish(4003)
        return
      }
    val pinMatched = AtomicBoolean(false)
    val trustManager =
      PinnedTrustManager(endpoint.host, fingerprint, nowMs, systemTrustManager(), pinMatched)
    val context = SSLContext.getInstance("TLS")
    context.init(null, arrayOf(trustManager), null)
    val built =
      OkHttpClient.Builder()
        .sslSocketFactory(context.socketFactory, trustManager)
        .hostnameVerifier(PinnedHostnameVerifier(endpoint.host, pinMatched))
        .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()
    client = built
    val request =
      Request.Builder().url(endpoint.url).header("Cache-Control", "no-store").build()
    socket = built.newWebSocket(request, SocketListener())
  }

  fun send(text: String) {
    val current = socket
    if (current == null || !current.send(text)) {
      finish(1006)
    }
  }

  /**
   * Local close. Like iOS `PinnedSocket.close`, no `onClose` follows a locally
   * initiated close; the opener already knows the socket is gone.
   */
  fun close() {
    if (!ended.getAndSet(true)) {
      try {
        socket?.close(1000, null)
      } catch (e: Exception) {
        // Already gone; fall through to delayed release.
      }
      // No onClose follows (iOS parity). Release dispatcher threads after a
      // grace period so the close handshake can complete; a remote close that
      // lands first releases them immediately through finish().
      cleanup.schedule({ release() }, 5, TimeUnit.SECONDS)
    }
  }

  private fun finish(code: Int) {
    if (!ended.getAndSet(true)) {
      try {
        events.onClose(code)
      } finally {
        release()
      }
    } else {
      release()
    }
  }

  private fun release() {
    socket = null
    try {
      client?.dispatcher?.executorService?.shutdown()
    } catch (e: Exception) {
      // Best effort.
    } finally {
      client = null
    }
  }

  private inner class SocketListener : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      if (ended.get()) return
      events.onOpen()
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      if (ended.get()) return
      if (text.toByteArray(Charsets.UTF_8).size > PinnedTrust.MAX_SOCKET_MESSAGE_BYTES) {
        webSocket.close(1009, null)
        finish(1002)
        return
      }
      events.onMessage(text)
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
      if (ended.get()) return
      if (bytes.size > PinnedTrust.MAX_SOCKET_MESSAGE_BYTES) {
        webSocket.close(1009, null)
        finish(1002)
        return
      }
      events.onBinary(bytes.toByteArray())
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      webSocket.close(code, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      finish(code)
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      if (ended.get()) return
      if (findHandshakeFailure(t) != null) {
        try {
          events.onTrust("pin")
        } finally {
          finish(4003)
        }
        return
      }
      finish(1006)
    }

    private fun findHandshakeFailure(error: Throwable?): PinnedHandshakeException? {
      var cause = error
      while (cause != null) {
        if (cause is PinnedHandshakeException) return cause
        cause = cause.cause
      }
      return null
    }
  }

  companion object {
    private val cleanup = Executors.newSingleThreadScheduledExecutor { runnable ->
      Thread(runnable, "pinned-socket-cleanup").apply { isDaemon = true }
    }

    data class Endpoint(val url: String, val host: String)

    /**
     * Production requires pinned WSS: no credentials, query or fragment, and
     * a valid pin. There is no loopback `ws` exception; the debug fixture
     * runtime stays on its own transport.
     *
     * Parsed with `java.net.URI` because OkHttp's `HttpUrl` only models
     * `http(s)` (a `wss:` string given to `Request.Builder` is normalized to
     * `https:` for the TLS handshake, which our trust manager still pins).
     */
    fun validateSocketTarget(url: String, fingerprint: String): Endpoint {
      val uri =
        try {
          java.net.URI(url)
        } catch (e: Exception) {
          throw PinnedHttpFailure.Invalid()
        }
      val host = uri.host
      if (!uri.scheme.equals("wss", ignoreCase = true) || uri.userInfo != null ||
        host.isNullOrEmpty() || uri.rawQuery != null || uri.fragment != null ||
        (uri.rawPath != "" && uri.rawPath != "/")
      ) {
        throw PinnedHttpFailure.Invalid()
      }
      PinnedPolicy.validatePin(fingerprint)
      return Endpoint(url, host)
    }
  }
}
