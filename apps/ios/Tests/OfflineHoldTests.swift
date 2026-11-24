import Testing
@testable import Ace

/// When the runtimes hear the phone went offline.
@Suite struct OfflineHoldTests {
    @Test func aPathThatComesBackInsideTheHoldIsNeverTold() {
        var hold = OfflineHold()
        #expect(hold.path(online: false, at: 1_000) == .check(at: 1_000 + OfflineHold.hold))
        #expect(hold.path(online: true, at: 2_000) == .none)
        #expect(hold.elapsed(at: 1_000 + OfflineHold.hold) == .none)
    }

    @Test func aPathDownPastTheHoldIsToldOfflineThenOnlineAtOnce() {
        var hold = OfflineHold()
        _ = hold.path(online: false, at: 0)
        #expect(hold.path(online: false, at: 1_000) == .check(at: OfflineHold.hold))
        #expect(hold.elapsed(at: OfflineHold.hold - 1) == .check(at: OfflineHold.hold))
        #expect(hold.elapsed(at: OfflineHold.hold) == .tell(online: false))
        #expect(hold.path(online: false, at: 9_000) == .none)
        #expect(hold.path(online: true, at: 10_000) == .tell(online: true))
    }
}
