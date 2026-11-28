package dev.ace.nativeui.transport

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Registry lifecycle: a stale close from a replaced socket must never evict
 * its replacement. Regression test for the review finding where `onClose`
 * removed the id unconditionally, so an old socket's late close dropped the
 * new socket from the map and leaked it (never closed, never reachable).
 */
class PinnedSocketRegistryTest {
  private class FakeSocket(val name: String) {
    var closed = false
    fun close() {
      closed = true
    }
  }

  @Test
  fun `stale close keeps the replacement and reports itself stale`() {
    val registry = PinnedSocketRegistry<FakeSocket>()
    val old = FakeSocket("old")
    val new = FakeSocket("new")
    assertNull(registry.replace("s", old))
    // Reopen: the bridge closes the displaced socket after replacing it.
    assertSame(old, registry.replace("s", new))
    old.close()
    assertTrue(old.closed)

    // The old socket's late onClose arrives after the reopen.
    assertFalse(registry.removeIfCurrent("s", old))
    assertSame(new, registry.current("s"))
    assertFalse(new.closed)
  }

  @Test
  fun `current close removes exactly once, then reports stale`() {
    val registry = PinnedSocketRegistry<FakeSocket>()
    val socket = FakeSocket("only")
    registry.replace("s", socket)
    assertTrue(registry.removeIfCurrent("s", socket))
    assertNull(registry.current("s"))
    assertFalse(registry.removeIfCurrent("s", socket))
  }

  @Test
  fun `explicit take removes the current entry for close`() {
    val registry = PinnedSocketRegistry<FakeSocket>()
    val socket = FakeSocket("only")
    registry.replace("s", socket)
    assertSame(socket, registry.take("s"))
    assertNull(registry.current("s"))
    // A late close from the explicitly closed socket is stale.
    assertFalse(registry.removeIfCurrent("s", socket))
  }

  @Test
  fun `replacing an id with itself displaces nothing`() {
    val registry = PinnedSocketRegistry<FakeSocket>()
    val socket = FakeSocket("only")
    registry.replace("s", socket)
    assertNull(registry.replace("s", socket))
    assertSame(socket, registry.current("s"))
  }

  @Test
  fun `concurrent reopen and stale close never lose the replacement`() {
    repeat(50) {
      val registry = PinnedSocketRegistry<FakeSocket>()
      val old = FakeSocket("old")
      val new = FakeSocket("new")
      registry.replace("s", old)
      val start = CountDownLatch(2)
      val done = CountDownLatch(2)
      val staleResult = AtomicReference<Boolean>()
      Thread {
        start.countDown()
        start.await(10, TimeUnit.SECONDS)
        registry.replace("s", new)
        done.countDown()
      }.apply { isDaemon = true }.start()
      Thread {
        start.countDown()
        start.await(10, TimeUnit.SECONDS)
        // Simulates the old socket's late onClose racing the reopen.
        staleResult.set(registry.removeIfCurrent("s", old))
        done.countDown()
      }.apply { isDaemon = true }.start()
      assertTrue(done.await(10, TimeUnit.SECONDS))
      if (staleResult.get()) {
        // The stale close won the race and removed the old entry before the
        // reopen; the reopen then reinstalled the replacement.
        assertSame(new, registry.current("s"))
      } else {
        // The reopen won; the stale close correctly left it in place.
        assertSame(new, registry.current("s"))
      }
      // The replacement is always still owned exactly once.
      assertTrue(registry.removeIfCurrent("s", new))
      assertNull(registry.current("s"))
    }
  }

  @Test
  fun `stale non-close events are detectable via identity`() {
    val registry = PinnedSocketRegistry<FakeSocket>()
    val old = FakeSocket("old")
    val new = FakeSocket("new")
    registry.replace("s", old)
    registry.replace("s", new)
    // The bridge drops open/message/binary/trust from a socket that is no
    // longer current, so a replaced session cannot inject frames into the
    // new session sharing its id.
    assertFalse(registry.isCurrent("s", old))
    assertTrue(registry.isCurrent("s", new))
    assertEquals(new, registry.current("s"))
  }
}
