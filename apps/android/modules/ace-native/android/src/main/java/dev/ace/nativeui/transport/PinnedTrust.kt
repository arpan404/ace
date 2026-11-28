package dev.ace.nativeui.transport

import java.security.MessageDigest
import java.security.cert.X509Certificate
import javax.net.ssl.X509ExtendedTrustManager

/**
 * The only trust decision for ace's HTTPS and WSS, mirroring iOS `PinnedTrust`
 * and `apps/android/src/security/trust.ts`: the QR-confirmed SHA-256 DER SPKI
 * pin plus the certificate's validity window. One exception (ADR 0097): a
 * Tailscale `*.ts.net` host may present the publicly trusted certificate
 * Tailscale issues for that exact name. No other host ever falls back to
 * system trust.
 *
 * The TLS handshake runs this decision before any request bytes are written,
 * so a mismatched pin fails closed with no code, token or ticket leaving.
 */
sealed class PinnedTrustFailure(message: String) : Exception(message) {
  /** Reported to JS as `"pin"`. */
  class Mismatch : PinnedTrustFailure("pin")

  /** Reported to JS as `"pin"`: the daemon's identity is not usable now. */
  class Expired : PinnedTrustFailure("expired")

  /** Reported to JS as `"invalid"`: the presented chain could not be read. */
  class Malformed : PinnedTrustFailure("malformed")
}

object PinnedTrust {
  const val MAX_RESPONSE_BYTES = 1_048_576
  const val MAX_BODY_BYTES = 4096
  const val MAX_PATH_BYTES = 256
  const val MAX_SOCKET_MESSAGE_BYTES = 2 * 1024 * 1024

  /** A 64-character lowercase hex SHA-256 digest, as the daemon's pin format requires. */
  fun isPin(value: String): Boolean =
    value.length == 64 && value.all { it in '0'..'9' || it in 'a'..'f' }

  /**
   * A Tailscale MagicDNS name: only the machine holding the name can get a
   * public certificate for it, so only these names qualify for the ADR 0097
   * system-trust exception.
   */
  fun isTailnetName(host: String): Boolean {
    val name = host.lowercase().removeSuffix(".")
    return name.endsWith(".ts.net") && name.length > ".ts.net".length
  }

  /**
   * Lowercase hex SHA-256 of the leaf certificate's DER SubjectPublicKeyInfo,
   * including its algorithm identifier. `publicKey.encoded` is exactly that
   * DER SPKI (same bytes iOS hashes and the daemon's `publicKeyFingerprint`
   * hashes); an exported raw key alone must never be hashed as a pin.
   */
  fun spkiPin(certificate: X509Certificate): String {
    val spki =
      try {
        certificate.publicKey.encoded
      } catch (e: Exception) {
        throw PinnedTrustFailure.Malformed()
      }
    if (spki.isEmpty()) throw PinnedTrustFailure.Malformed()
    val digest = MessageDigest.getInstance("SHA-256").digest(spki)
    return digest.joinToString("") { "%02x".format(it) }
  }

  /**
   * Pure decision mirroring `decideTrust`: the exact pinned key inside its
   * validity window authenticates the daemon. On a pin mismatch only a
   * `*.ts.net` host presenting a system-trusted chain for that exact name
   * may pass. `systemTrusts` must validate the chain (including its window)
   * for this exact host and never be consulted when the pin matches.
   */
  fun decide(
    actualPin: String,
    expectedPin: String,
    host: String,
    nowMs: Long,
    notBeforeMs: Long,
    notAfterMs: Long,
    systemTrusts: () -> Boolean,
  ) {
    if (!isPin(actualPin) || !isPin(expectedPin)) throw PinnedTrustFailure.Malformed()
    if (notBeforeMs > notAfterMs) throw PinnedTrustFailure.Malformed()
    if (actualPin != expectedPin) {
      if (isTailnetName(host) && systemTrusts()) return
      throw PinnedTrustFailure.Mismatch()
    }
    if (nowMs < notBeforeMs || nowMs >= notAfterMs) throw PinnedTrustFailure.Expired()
  }

  /** Leaf validity window in epoch milliseconds, read from the handshake. */
  fun validityWindow(certificate: X509Certificate): Pair<Long, Long> {
    val start = certificate.notBefore.time
    val end = certificate.notAfter.time
    if (start > end) throw PinnedTrustFailure.Malformed()
    return start to end
  }

  /**
   * Exact-host check for the ADR 0097 fallback: a dNSName SAN must match the
   * host, with one left-label wildcard allowed; otherwise the CN must equal
   * the host. Matching is case-insensitive with no trailing-dot mismatch.
   */
  fun hostMatches(certificate: X509Certificate, host: String): Boolean {
    val want = host.lowercase().removeSuffix(".")
    if (want.isEmpty()) return false
    val sans =
      try {
        certificate.subjectAlternativeNames
      } catch (e: Exception) {
        null
      }
    val dns = sans?.filter { it[0] == 2 }?.mapNotNull { it[1] as? String } ?: emptyList()
    if (dns.isNotEmpty()) return dns.any { matchesName(it, want) }
    val dn = certificate.subjectX500Principal.name
    val cn = Regex("CN=([^,]+)").find(dn)?.groupValues?.get(1)?.trim()
    return cn != null && matchesName(cn, want)
  }

  private fun matchesName(pattern: String, host: String): Boolean {
    val clean = pattern.lowercase().removeSuffix(".")
    if (!clean.contains("*")) return clean == host
    if (!clean.startsWith("*.")) return false
    val suffix = clean.removePrefix("*")
    if (!host.endsWith(suffix)) return false
    val left = host.removeSuffix(suffix)
    return left.isNotEmpty() && !left.contains(".")
  }
}

/** Default platform trust used only for the `*.ts.net` exception path. */
fun systemTrustManager(): X509ExtendedTrustManager {
  val factory = javax.net.ssl.TrustManagerFactory.getInstance(
    javax.net.ssl.TrustManagerFactory.getDefaultAlgorithm(),
  )
  factory.init(null as java.security.KeyStore?)
  val system = factory.trustManagers.filterIsInstance<javax.net.ssl.X509TrustManager>().first()
  (system as? X509ExtendedTrustManager)?.let { return it }
  return object : X509ExtendedTrustManager() {
    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
      system.checkClientTrusted(chain, authType)
    }
    override fun checkClientTrusted(
      chain: Array<X509Certificate>,
      authType: String,
      socket: java.net.Socket,
    ) {
      system.checkClientTrusted(chain, authType)
    }
    override fun checkClientTrusted(
      chain: Array<X509Certificate>,
      authType: String,
      engine: javax.net.ssl.SSLEngine,
    ) {
      system.checkClientTrusted(chain, authType)
    }
    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
      system.checkServerTrusted(chain, authType)
    }
    override fun checkServerTrusted(
      chain: Array<X509Certificate>,
      authType: String,
      socket: java.net.Socket,
    ) {
      system.checkServerTrusted(chain, authType)
    }
    override fun checkServerTrusted(
      chain: Array<X509Certificate>,
      authType: String,
      engine: javax.net.ssl.SSLEngine,
    ) {
      system.checkServerTrusted(chain, authType)
    }
    override fun getAcceptedIssuers(): Array<X509Certificate> = system.acceptedIssuers
  }
}
