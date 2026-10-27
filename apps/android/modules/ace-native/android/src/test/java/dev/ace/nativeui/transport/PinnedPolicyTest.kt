package dev.ace.nativeui.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

/** Request policy: malformed pairing requests fail before any network I/O. */
class PinnedPolicyTest {
  private val pin = "9f".repeat(32)
  private val origin = "https://192.168.1.20:4243/"

  @Test
  fun `accepts the stripped daemon origin`() {
    assertEquals(origin, PinnedPolicy.validateOrigin(origin).toString())
    assertEquals(origin, PinnedPolicy.validateOrigin("https://192.168.1.20:4243").toString())
  }

  @Test
  fun `rejects origins that carry credentials queries fragments or paths`() {
    for (bad in listOf(
      "http://192.168.1.20:4243/",
      "https://user@192.168.1.20:4243/",
      "https://192.168.1.20:4243/?x=1",
      "https://192.168.1.20:4243/#frag",
      "https://192.168.1.20:4243/pair",
      "not a url",
      "https://",
    )) {
      try {
        PinnedPolicy.validateOrigin(bad)
        fail("origin must fail: $bad")
      } catch (e: PinnedHttpFailure.Invalid) {
        // Expected.
      }
    }
  }

  @Test
  fun `requires a well formed pin`() {
    assertEquals(pin, PinnedPolicy.validatePin(pin))
    for (bad in listOf("", "short", pin.uppercase(), "zz".repeat(32))) {
      try {
        PinnedPolicy.validatePin(bad)
        fail("pin must fail: $bad")
      } catch (e: PinnedHttpFailure.Invalid) {
        // Expected.
      }
    }
  }

  @Test
  fun `builds request urls from the bound origin plus the fixed path`() {
    val base = PinnedPolicy.validateOrigin(origin)
    assertEquals(
      "https://192.168.1.20:4243/v1/pair",
      PinnedPolicy.requestUrl(base, "POST", "/v1/pair").toString(),
    )
  }

  @Test
  fun `rejects request shapes outside the fixed contract`() {
    val base = PinnedPolicy.validateOrigin(origin)
    val bad = listOf(
      Triple("GET", "/v1/../pair", null),
      Triple("GET", "/status", null),
      Triple("DELETE", "/v1/pair", null),
      Triple("GET", "/v1/pair?x=1", null),
      Triple("GET", "/v1/pa ir", null),
      Triple("POST", "/v1/${"a".repeat(300)}", null),
    )
    for ((method, path, body) in bad) {
      try {
        PinnedPolicy.requestUrl(base, method, path)
        fail("request must fail: $method $path")
      } catch (e: PinnedHttpFailure.Invalid) {
        // Expected.
      }
    }
    try {
      PinnedPolicy.validateBody("x".repeat(PinnedTrust.MAX_BODY_BYTES + 1))
      fail("oversize body must fail")
    } catch (e: PinnedHttpFailure.Invalid) {
      // Expected.
    }
    try {
      PinnedPolicy.validateToken("bad")
      fail("malformed token must fail")
    } catch (e: PinnedHttpFailure.Invalid) {
      // Expected.
    }
    PinnedPolicy.validateBody(null)
    PinnedPolicy.validateToken(null)
    PinnedPolicy.validateToken(pin)
  }

  @Test
  fun `validates wss endpoints with a pin and no fixture exception`() {
    val endpoint = PinnedSocket.validateSocketTarget("wss://192.168.1.20:4243/", pin)
    assertEquals("192.168.1.20", endpoint.host)
    PinnedSocket.validateSocketTarget("wss://192.168.1.20:4243", pin)
    for (bad in listOf(
      "ws://127.0.0.1:4345/",
      "wss://user@host:1/",
      "wss://host:1/?x=1",
      "wss://host:1/#f",
      "wss://host:1/path",
      "https://host:1/",
      "not a url",
    )) {
      try {
        PinnedSocket.validateSocketTarget(bad, pin)
        fail("socket target must fail: $bad")
      } catch (e: PinnedHttpFailure.Invalid) {
        // Expected.
      }
    }
    try {
      PinnedSocket.validateSocketTarget("wss://host:1/", "short")
      fail("bad pin must fail")
    } catch (e: PinnedHttpFailure.Invalid) {
      // Expected.
    }
  }
}
