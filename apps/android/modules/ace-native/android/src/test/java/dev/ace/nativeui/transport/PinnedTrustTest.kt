package dev.ace.nativeui.transport

import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Trust decisions against a checked-in self-signed certificate whose DER SPKI
 * pin was computed independently with OpenSSL:
 *
 *   openssl x509 -pubkey -noout |
 *   openssl pkey -pubin -outform DER | sha256sum
 *
 * SAN: DNS:mac.tail0.ts.net. Validity 2026-10-27 to 2036-10-24.
 */
class PinnedTrustTest {
  companion object {
    const val VECTOR_PIN = "f79991d30936286cc9a8d7e44397f402ac9bf19149ca1bc3a97b05de5a7bfd13"
    const val OTHER_PIN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    fun vectorCert(): X509Certificate {
      val stream =
        javaClass.classLoader.getResourceAsStream("pinned-test-cert.pem")
          ?: throw AssertionError("missing test certificate")
      return stream.use {
        CertificateFactory.getInstance("X.509").generateCertificate(it) as X509Certificate
      }
    }
  }

  private val nowInsideWindow = 1_800_000_000_000L // 2027-01-15, inside the vector window.

  @Test
  fun `spki digest matches the independently computed vector`() {
    assertEquals(VECTOR_PIN, PinnedTrust.spkiPin(vectorCert()))
  }

  @Test
  fun `trusts the exact pinned key inside its validity window`() {
    val (start, end) = PinnedTrust.validityWindow(vectorCert())
    PinnedTrust.decide(VECTOR_PIN, VECTOR_PIN, "192.168.1.20", nowInsideWindow, start, end) {
      throw AssertionError("system trust must not be consulted when the pin matches")
    }
    // The checked-in window really is 2026-10-27 to 2036-10-24.
    assertEquals(1_793_074_738_000L, start)
    assertEquals(2_108_434_738_000L, end)
  }

  @Test
  fun `rejects a changed pin before any credential leaves`() {
    val (start, end) = PinnedTrust.validityWindow(vectorCert())
    try {
      PinnedTrust.decide(OTHER_PIN, VECTOR_PIN, "192.168.1.20", nowInsideWindow, start, end) {
        true
      }
      fail("mismatched pin must fail closed")
    } catch (e: PinnedTrustFailure.Mismatch) {
      // Expected.
    }
  }

  @Test
  fun `accepts a publicly trusted certificate only for the exact ts net name`() {
    val (start, end) = PinnedTrust.validityWindow(vectorCert())
    PinnedTrust.decide(OTHER_PIN, VECTOR_PIN, "mac.tail0.ts.net", nowInsideWindow, start, end) {
      true
    }
    try {
      PinnedTrust.decide(OTHER_PIN, VECTOR_PIN, "mac.tail0.ts.net", nowInsideWindow, start, end) {
        false
      }
      fail("untrusted ts.net chain must fail")
    } catch (e: PinnedTrustFailure.Mismatch) {
      // Expected.
    }
    try {
      PinnedTrust.decide(OTHER_PIN, VECTOR_PIN, "192.168.1.20", nowInsideWindow, start, end) {
        true
      }
      fail("non-tailnet host must never fall back to system trust")
    } catch (e: PinnedTrustFailure.Mismatch) {
      // Expected.
    }
  }

  @Test
  fun `rejects expired certificates even with system trust`() {
    val (start, end) = PinnedTrust.validityWindow(vectorCert())
    try {
      PinnedTrust.decide(VECTOR_PIN, VECTOR_PIN, "mac.tail0.ts.net", end, start, end) { true }
      fail("expired pin match must fail")
    } catch (e: PinnedTrustFailure.Expired) {
      // Expected: pin matched, window did not.
    }
    try {
      PinnedTrust.decide(VECTOR_PIN, VECTOR_PIN, "mac.tail0.ts.net", start - 1, start, end) {
        false
      }
      fail("not-yet-valid pin match must fail")
    } catch (e: PinnedTrustFailure.Expired) {
      // Expected.
    }
  }

  @Test
  fun `rejects malformed pins and windows without consulting system trust`() {
    val (start, end) = PinnedTrust.validityWindow(vectorCert())
    for (bad in listOf("short", VECTOR_PIN.uppercase(), "zz".repeat(32))) {
      try {
        PinnedTrust.decide(bad, VECTOR_PIN, "h", nowInsideWindow, start, end) {
          throw AssertionError("system trust must not be consulted for malformed input")
        }
        fail("malformed pin must fail: $bad")
      } catch (e: PinnedTrustFailure.Malformed) {
        // Expected.
      }
    }
    try {
      PinnedTrust.decide(VECTOR_PIN, VECTOR_PIN, "h", nowInsideWindow, end, start) {
        throw AssertionError("system trust must not be consulted for malformed input")
      }
      fail("inverted window must fail")
    } catch (e: PinnedTrustFailure.Malformed) {
      // Expected.
    }
  }

  @Test
  fun `recognizes only tailscale magic dns names`() {
    assertTrue(PinnedTrust.isTailnetName("mac.tail0.ts.net"))
    assertTrue(PinnedTrust.isTailnetName("MAC.TAIL0.TS.NET."))
    assertFalse(PinnedTrust.isTailnetName("ts.net"))
    assertFalse(PinnedTrust.isTailnetName("example.com"))
    assertFalse(PinnedTrust.isTailnetName("100.64.0.1"))
    assertFalse(PinnedTrust.isTailnetName("mac.ts.net.evil.com"))
  }

  @Test
  fun `accepts only 64 lowercase hex pins`() {
    assertTrue(PinnedTrust.isPin(VECTOR_PIN))
    assertFalse(PinnedTrust.isPin(VECTOR_PIN.uppercase()))
    assertFalse(PinnedTrust.isPin(""))
  }

  @Test
  fun `matches the exact tailnet name from the san`() {
    val cert = vectorCert()
    assertTrue(PinnedTrust.hostMatches(cert, "mac.tail0.ts.net"))
    assertTrue(PinnedTrust.hostMatches(cert, "MAC.TAIL0.TS.NET."))
    assertFalse(PinnedTrust.hostMatches(cert, "other.tail0.ts.net"))
    assertFalse(PinnedTrust.hostMatches(cert, "mac.tail0.ts.net.evil.com"))
  }
}
