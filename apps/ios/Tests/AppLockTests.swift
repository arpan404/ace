import Foundation
import Testing
@testable import Ace

@Suite @MainActor struct AppLockTests {
    @Test func aPairedPhoneStartsLockedAndUnlocksOnlyAfterAuthentication() async {
        let clock = Clock()
        let auth = ScriptedAuthenticator([.failed, .success])
        let lock = AppLock(enabled: true, now: clock.read, authenticator: auth)
        #expect(lock.locked)
        await lock.unlock()
        #expect(lock.locked)
        #expect(lock.failed)
        await lock.unlock()
        #expect(!lock.locked)
    }
    @Test func returningAfterTheTimeoutLocksAndAQuickReturnDoesNot() async {
        let clock = Clock()
        let lock = AppLock(enabled: true, timeout: 60, now: clock.read, authenticator: ScriptedAuthenticator([.success]))
        await lock.unlock()
        lock.didEnterBackground()
        clock.now += 59
        lock.didBecomeActive()
        #expect(!lock.locked)
        lock.didEnterBackground()
        clock.now += 60
        lock.didBecomeActive()
        #expect(lock.locked)
    }
    @Test func anUnpairedPhoneIsNotLockedUntilItsFirstPairing() {
        let clock = Clock()
        let lock = AppLock(enabled: false, timeout: 60, now: clock.read, authenticator: ScriptedAuthenticator([]))
        #expect(!lock.locked)
        lock.enable()
        lock.didEnterBackground()
        clock.now += 61
        lock.didBecomeActive()
        #expect(lock.locked)
    }
    @Test func aPhoneWithoutAPasscodeHasNothingToUnlockWith() async {
        let lock = AppLock(enabled: true, now: { Date(timeIntervalSince1970: 0) }, authenticator: ScriptedAuthenticator([.unavailable]))
        await lock.unlock()
        #expect(!lock.locked)
    }
}

@MainActor private final class Clock {
    var now = Date(timeIntervalSince1970: 1_000)
    var read: () -> Date { { [unowned self] in self.now } }
}
private final class ScriptedAuthenticator: Authenticator, @unchecked Sendable {
    private let lock = NSLock()
    private var outcomes: [AuthenticationOutcome]
    init(_ outcomes: [AuthenticationOutcome]) { self.outcomes = outcomes }
    func authenticate(reason: String) async -> AuthenticationOutcome {
        lock.withLock { outcomes.isEmpty ? .failed : outcomes.removeFirst() }
    }
}
