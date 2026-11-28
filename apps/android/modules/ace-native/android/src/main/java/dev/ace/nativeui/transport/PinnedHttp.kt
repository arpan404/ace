package dev.ace.nativeui.transport

import java.net.Socket
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLSession
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509ExtendedTrustManager
import okhttp3.ConnectionSpec
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Refusals reported to JS instead of a response. Raw values match iOS
 * `PinnedHTTPError` and the TS `PinnedRefusal` contract.
 */
sealed class PinnedHttpFailure(val reason: String) : Exception(reason) {
  class Pin : PinnedHttpFailure("pin")
  class Redirect : PinnedHttpFailure("redirect")
  class Offline : PinnedHttpFailure("offline")
  class Limit : PinnedHttpFailure("limit")
  class Invalid : PinnedHttpFailure("invalid")
}

/** Internal handshake signal, mapped to [PinnedHttpFailure] at the boundary. */
internal class PinnedHandshakeException(val failure: PinnedHttpFailure) :
  CertificateException(failure.reason)

/**
 * Trust manager enforcing the pinned key before any request bytes flow.
 * The exact pin inside its validity window authenticates the daemon; on a
 * mismatch only a `*.ts.net` host presenting a system-trusted chain for that
 * exact name may pass. The expected host is bound on every path.
 */
internal class PinnedTrustManager(
  private val expectedHost: String,
  private val expectedPin: String,
  private val nowMs: () -> Long,
  private val system: X509ExtendedTrustManager,
  private val pinMatched: AtomicBoolean,
) : X509ExtendedTrustManager() {
  override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
    throw CertificateException("client trust is never used")
  }

  override fun checkClientTrusted(
    chain: Array<X509Certificate>,
    authType: String,
    socket: Socket,
  ) {
    throw CertificateException("client trust is never used")
  }

  override fun checkClientTrusted(
    chain: Array<X509Certificate>,
    authType: String,
    engine: SSLEngine,
  ) {
    throw CertificateException("client trust is never used")
  }

  override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
    verify(chain, authType, expectedHost)
  }

  override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String, socket: Socket) {
    val peer = (socket as? SSLSocket)?.handshakeSession?.peerHost ?: expectedHost
    verify(chain, authType, peer)
  }

  override fun checkServerTrusted(
    chain: Array<X509Certificate>,
    authType: String,
    engine: SSLEngine,
  ) {
    verify(chain, authType, engine.peerHost ?: expectedHost)
  }

  override fun getAcceptedIssuers(): Array<X509Certificate> = system.acceptedIssuers

  private fun verify(chain: Array<X509Certificate>, authType: String, peerHost: String) {
    if (!peerHost.equals(expectedHost, ignoreCase = true)) {
      throw PinnedHandshakeException(PinnedHttpFailure.Pin())
    }
    val leaf = chain.firstOrNull() ?: throw PinnedHandshakeException(PinnedHttpFailure.Invalid())
    val actual =
      try {
        PinnedTrust.spkiPin(leaf)
      } catch (e: PinnedTrustFailure) {
        throw PinnedHandshakeException(PinnedHttpFailure.Invalid())
      }
    val (start, end) =
      try {
        PinnedTrust.validityWindow(leaf)
      } catch (e: PinnedTrustFailure) {
        throw PinnedHandshakeException(PinnedHttpFailure.Invalid())
      }
    val pinned = actual == expectedPin
    try {
      PinnedTrust.decide(actual, expectedPin, expectedHost, nowMs(), start, end) {
        try {
          system.checkServerTrusted(chain, authType)
        } catch (e: Exception) {
          return@decide false
        }
        PinnedTrust.hostMatches(leaf, expectedHost)
      }
    } catch (e: PinnedTrustFailure.Mismatch) {
      throw PinnedHandshakeException(PinnedHttpFailure.Pin())
    } catch (e: PinnedTrustFailure.Expired) {
      throw PinnedHandshakeException(PinnedHttpFailure.Pin())
    } catch (e: PinnedTrustFailure.Malformed) {
      throw PinnedHandshakeException(PinnedHttpFailure.Invalid())
    }
    if (pinned) pinMatched.set(true)
  }
}

/**
 * Hostname binding lives in the trust manager; the verifier additionally
 * requires the exact expected host and accepts the connection when the pin
 * matched or the platform trusts it for this name (the `*.ts.net` path).
 */
internal class PinnedHostnameVerifier(
  private val expectedHost: String,
  private val pinMatched: AtomicBoolean,
  private val platform: HostnameVerifier = HttpsURLConnection.getDefaultHostnameVerifier(),
) : HostnameVerifier {
  override fun verify(hostname: String, session: SSLSession): Boolean {
    if (!hostname.equals(expectedHost, ignoreCase = true)) return false
    return pinMatched.getAndSet(false) || platform.verify(hostname, session)
  }
}

data class PinnedHttpResponse(val status: Int, val body: String)

/**
 * One request over HTTPS whose server must present the pinned public key.
 * Credentials are written only after the pin and validity check pass during
 * the handshake; redirects are refused, never followed.
 */
class PinnedHttpClient(
  origin: String,
  fingerprint: String,
  private val nowMs: () -> Long = System::currentTimeMillis,
) {
  private val base = PinnedPolicy.validateOrigin(origin)
  private val pin = PinnedPolicy.validatePin(fingerprint)
  private val host = base.host
  private val pinMatched = AtomicBoolean(false)
  private val trustManager =
    PinnedTrustManager(host, pin, nowMs, systemTrustManager(), pinMatched)

  private val client: OkHttpClient = buildClient()

  private fun buildClient(): OkHttpClient {
    val context = SSLContext.getInstance("TLS")
    context.init(null, arrayOf(trustManager), null)
    return OkHttpClient.Builder()
      .sslSocketFactory(context.socketFactory, trustManager)
      .hostnameVerifier(PinnedHostnameVerifier(host, pinMatched))
      .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))
      .followRedirects(false)
      .followSslRedirects(false)
      .connectTimeout(15, TimeUnit.SECONDS)
      .readTimeout(15, TimeUnit.SECONDS)
      .writeTimeout(15, TimeUnit.SECONDS)
      .callTimeout(20, TimeUnit.SECONDS)
      .build()
  }

  /** Blocking; call off the main thread (the Expo bridge uses a worker). */
  fun execute(method: String, path: String, body: String?, token: String?): PinnedHttpResponse {
    val url = PinnedPolicy.requestUrl(base, method, path)
    PinnedPolicy.validateBody(body)
    PinnedPolicy.validateToken(token)
    val builder = Request.Builder().url(url).header("Cache-Control", "no-store")
    token?.let { builder.header("Authorization", "Bearer $it") }
    val request =
      when (method) {
        "GET" -> builder.get().build()
        "POST" ->
          builder
            .post((body ?: "").toRequestBody(if (body == null) null else JSON_MEDIA_TYPE))
            .apply { if (body != null) header("Content-Type", "application/json") }
            .build()
        else -> throw PinnedHttpFailure.Invalid()
      }
    try {
      client.newCall(request).execute().use { response ->
        if (response.code in 300..399) throw PinnedHttpFailure.Redirect()
        val body = response.body ?: throw PinnedHttpFailure.Offline()
        val contentLength = body.contentLength()
        if (contentLength > PinnedTrust.MAX_RESPONSE_BYTES) throw PinnedHttpFailure.Limit()
        val source = body.source()
        source.request(PinnedTrust.MAX_RESPONSE_BYTES + 1L)
        if (source.buffer.size > PinnedTrust.MAX_RESPONSE_BYTES) {
          throw PinnedHttpFailure.Limit()
        }
        val text =
          try {
            source.readUtf8()
          } catch (e: Exception) {
            throw PinnedHttpFailure.Invalid()
          }
        return PinnedHttpResponse(response.code, text)
      }
    } catch (e: PinnedHttpFailure) {
      throw e
    } catch (e: Exception) {
      throw mapTransportError(e)
    }
  }

  private fun mapTransportError(error: Throwable): PinnedHttpFailure {
    var cause: Throwable? = error
    while (cause != null) {
      if (cause is PinnedHandshakeException) {
        return when (cause.failure) {
          is PinnedHttpFailure.Pin -> PinnedHttpFailure.Pin()
          else -> PinnedHttpFailure.Invalid()
        }
      }
      cause = cause.cause
    }
    return PinnedHttpFailure.Offline()
  }

  companion object {
    private val JSON_MEDIA_TYPE = "application/json".toMediaType()
  }
}

/** Pure request policy mirroring iOS `PinnedHTTP.urlRequest` and the TS layer. */
object PinnedPolicy {
  fun validatePin(fingerprint: String): String {
    if (!PinnedTrust.isPin(fingerprint)) throw PinnedHttpFailure.Invalid()
    return fingerprint
  }

  fun validateOrigin(origin: String): okhttp3.HttpUrl {
    val url =
      try {
        origin.toHttpUrlOrNull() ?: throw PinnedHttpFailure.Invalid()
      } catch (e: PinnedHttpFailure) {
        throw e
      } catch (e: Exception) {
        throw PinnedHttpFailure.Invalid()
      }
    if (url.scheme != "https" || url.username.isNotEmpty() || url.password.isNotEmpty() ||
      url.query != null || url.fragment != null ||
      (url.encodedPath != "" && url.encodedPath != "/") || url.host.isEmpty()
    ) {
      throw PinnedHttpFailure.Invalid()
    }
    return url
  }

  fun validateToken(token: String?) {
    if (token != null && !PinnedTrust.isPin(token)) throw PinnedHttpFailure.Invalid()
  }

  fun validateBody(body: String?) {
    if (body != null && body.toByteArray(Charsets.UTF_8).size > PinnedTrust.MAX_BODY_BYTES) {
      throw PinnedHttpFailure.Invalid()
    }
  }

  fun requestUrl(base: okhttp3.HttpUrl, method: String, path: String): okhttp3.HttpUrl {
    if (method != "GET" && method != "POST") throw PinnedHttpFailure.Invalid()
    if (!path.startsWith("/v1/")) throw PinnedHttpFailure.Invalid()
    if (path.toByteArray(Charsets.UTF_8).size > PinnedTrust.MAX_PATH_BYTES) {
      throw PinnedHttpFailure.Invalid()
    }
    if (!isPathChars(path) || path.contains("..")) throw PinnedHttpFailure.Invalid()
    val resolved = base.resolve(path.removePrefix("/")) ?: throw PinnedHttpFailure.Invalid()
    if (resolved.host != base.host || resolved.scheme != "https") throw PinnedHttpFailure.Invalid()
    return resolved
  }

  private fun isPathChars(path: String): Boolean {
    for (char in path) {
      val unit = char.code
      val allowed =
        (unit in 0x30..0x39) || (unit in 0x41..0x5A) || (unit in 0x61..0x7A) ||
          unit == 0x2D || unit == 0x2E || unit == 0x5F || unit == 0x7E ||
          unit == 0x21 || unit == 0x24 || unit == 0x26 || unit == 0x27 ||
          unit == 0x28 || unit == 0x29 || unit == 0x2A || unit == 0x2B ||
          unit == 0x2C || unit == 0x3B || unit == 0x3D || unit == 0x3A ||
          unit == 0x40 || unit == 0x2F || unit == 0x25
      if (!allowed) return false
    }
    return true
  }
}
