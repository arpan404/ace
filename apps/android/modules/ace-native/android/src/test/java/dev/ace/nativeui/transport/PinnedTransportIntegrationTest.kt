package dev.ace.nativeui.transport

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.ByteString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * Pinned transport against a loopback TLS server (no emulator, no device).
 * The server key is generated in-process; the client pin is derived from it,
 * so a wrong pin exercises the real handshake rejection path.
 */
class PinnedTransportIntegrationTest {
  private lateinit var server: MockWebServer
  private lateinit var held: HeldCertificate
  private lateinit var pin: String
  private lateinit var origin: String

  @Before
  fun setUp() {
    held =
      HeldCertificate.Builder().commonName("localhost")
        .addSubjectAlternativeName("localhost")
        .build()
    pin = PinnedTrust.spkiPin(held.certificate)
    val handshake =
      HandshakeCertificates.Builder().heldCertificate(held)
        .addTrustedCertificate(held.certificate)
        .build()
    server = MockWebServer()
    server.useHttps(handshake.sslSocketFactory(), false)
    server.start()
    origin = server.url("/").toString()
  }

  @After
  fun tearDown() {
    server.shutdown()
  }

  private fun client(pin: String): PinnedHttpClient =
    PinnedHttpClient(origin, pin, nowMs = System::currentTimeMillis)

  @Test
  fun `pinned request succeeds and carries no secret before validation`() {
    server.enqueue(MockResponse().setResponseCode(200).setBody("{\"ok\":true}"))
    val response = client(pin).execute("POST", "/v1/pair", "{\"code\":\"c\"}", null)
    assertEquals(200, response.status)
    assertEquals("{\"ok\":true}", response.body)
    val request = server.takeRequest(5, TimeUnit.SECONDS)!!
    assertEquals("/v1/pair", request.path)
    assertEquals("no-store", request.getHeader("Cache-Control"))
    assertNull(request.getHeader("Authorization"))
  }

  @Test
  fun `mismatched pin fails closed with nothing written`() {
    val token = "e0".repeat(32)
    server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
    try {
      client("aa".repeat(32)).execute("POST", "/v1/tickets", null, token)
      fail("mismatched pin must fail closed")
    } catch (e: PinnedHttpFailure.Pin) {
      // Expected: the TLS handshake rejected the key.
    }
    // No HTTP bytes followed the failed handshake, so the token never left.
    assertNull(server.takeRequest(500, TimeUnit.MILLISECONDS))
  }

  @Test
  fun `redirects are refused never followed`() {
    server.enqueue(
      MockResponse().setResponseCode(302).addHeader("Location", "/v1/other"),
    )
    try {
      client(pin).execute("GET", "/v1/status", null, null)
      fail("redirect must be refused")
    } catch (e: PinnedHttpFailure.Redirect) {
      // Expected.
    }
  }

  @Test
  fun `oversize responses are discarded`() {
    server.enqueue(
      MockResponse().setResponseCode(200)
        .setBody("x".repeat(PinnedTrust.MAX_RESPONSE_BYTES + 1)),
    )
    try {
      client(pin).execute("GET", "/v1/status", null, null)
      fail("oversize body must be discarded")
    } catch (e: PinnedHttpFailure.Limit) {
      // Expected.
    }
  }

  @Test
  fun `malformed tokens never reach the network`() {
    server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
    try {
      client(pin).execute("POST", "/v1/pair", "{}", "bad-token")
      fail("malformed token must fail")
    } catch (e: PinnedHttpFailure.Invalid) {
      // Expected.
    }
    assertNull(server.takeRequest(500, TimeUnit.MILLISECONDS))
  }

  @Test
  fun `pinned socket exchanges frames then closes`() {
    val opened = CountDownLatch(1)
    val message = CountDownLatch(1)
    val serverSawClose = CountDownLatch(1)
    val seen = mutableListOf<String>()
    server.enqueue(
      MockResponse().withWebSocketUpgrade(
        object : WebSocketListener() {
          override fun onMessage(webSocket: WebSocket, text: String) {
            webSocket.send("echo:$text")
          }
          override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, null)
          }
          override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            serverSawClose.countDown()
          }
        },
      ),
    );
    val socketUrl = origin.replace("https://", "wss://")
    val socket =
      PinnedSocket(socketUrl, pin, System::currentTimeMillis, object : PinnedSocket.SocketEvents {
        override fun onOpen() {
          opened.countDown()
        }
        override fun onMessage(text: String) {
          seen.add(text)
          message.countDown()
        }
        override fun onBinary(bytes: ByteArray) = Unit
        override fun onTrust(reason: String) = Unit
        // A locally initiated close reports nothing, mirroring iOS.
        override fun onClose(code: Int) {
          seen.add("close:$code")
        }
      })
    socket.open()
    assertTrue(opened.await(10, TimeUnit.SECONDS))
    socket.send("{\"type\":\"ping\"}")
    assertTrue(message.await(10, TimeUnit.SECONDS))
    assertEquals(listOf("echo:{\"type\":\"ping\"}"), seen.filter { !it.startsWith("close:") })
    socket.close()
    // The close frame reaches the server; the client stays silent afterwards.
    assertTrue(serverSawClose.await(10, TimeUnit.SECONDS))
    assertTrue(seen.none { it.startsWith("close:") })
  }

  @Test
  fun `pinned socket reports pin trust before the fatal close`() {
    val trust = CountDownLatch(1)
    val closed = CountDownLatch(1)
    val codes = mutableListOf<Int>()
    val reasons = mutableListOf<String>()
    val socketUrl = origin.replace("https://", "wss://")
    val socket =
      PinnedSocket(socketUrl, "bb".repeat(32), System::currentTimeMillis,
        object : PinnedSocket.SocketEvents {
          override fun onOpen() = fail("mismatched pin must never open")
          override fun onMessage(text: String) = fail("mismatched pin must never deliver")
          override fun onBinary(bytes: ByteArray) = fail("mismatched pin must never deliver")
          override fun onTrust(reason: String) {
            reasons.add(reason)
            trust.countDown()
          }
          override fun onClose(code: Int) {
            codes.add(code)
            closed.countDown()
          }
        })
    socket.open()
    assertTrue(trust.await(10, TimeUnit.SECONDS))
    assertTrue(closed.await(10, TimeUnit.SECONDS))
    assertEquals(listOf("pin"), reasons)
    assertEquals(listOf(4003), codes)
    socket.close()
  }
}
