import Foundation
import Testing
@testable import Ace

@Suite @MainActor struct BackgroundHoldTests {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    @Test func leavingTheAppHoldsATaskAndReturningReleasesItAndChecksTheSockets() {
        var hold = BackgroundHold(enabled: true)
        #expect(hold.phase(.inactive, now: t0) == [])
        #expect(hold.phase(.background, now: t0) == [.beginTask])
        #expect(hold.phase(.active, now: t0 + 10) == [.endTask, .wake])
    }
    @Test func withBackgroundRefreshOffNothingIsHeldButTheReturnStillChecksTheSockets() {
        var hold = BackgroundHold(enabled: false)
        #expect(hold.phase(.background, now: t0) == [])
        #expect(hold.phase(.active, now: t0 + 5) == [.wake])
    }
    @Test func aSwitcherPeekThatNeverLeavesTheScreenChangesNothing() {
        var hold = BackgroundHold(enabled: true)
        #expect(hold.phase(.inactive, now: t0) == [])
        #expect(hold.phase(.active, now: t0 + 1) == [])
    }
    @Test func iOSTakingTheGraceBackEndsTheTaskOnceAndTheReturnStillWakes() {
        var hold = BackgroundHold(enabled: true)
        _ = hold.phase(.background, now: t0)
        #expect(hold.expired() == [.endTask])
        #expect(hold.expired() == [])
        #expect(hold.phase(.active, now: t0 + 600) == [.wake])
    }
    @Test func repeatedBackgroundCallsHoldOneTask() {
        var hold = BackgroundHold(enabled: true)
        #expect(hold.phase(.background, now: t0) == [.beginTask])
        #expect(hold.phase(.background, now: t0 + 1) == [])
    }
    @Test func turningTheSettingOffWhileAwayReleasesTheTask() {
        var hold = BackgroundHold(enabled: true)
        _ = hold.phase(.background, now: t0)
        #expect(hold.setEnabled(false) == [.endTask])
        #expect(hold.phase(.active, now: t0 + 3) == [.wake])
    }
    @Test func theKeeperAsksIOSForOneTaskAndReleasesThatSameTask() {
        var began = 0, ended: [Int] = [], woke = 0
        var expire: (@MainActor () -> Void)?
        let keeper = BackgroundKeeper(enabled: true, now: { Date(timeIntervalSince1970: 0) },
            begin: { handler in began += 1; expire = handler; return 7 }, end: { ended.append($0) }, wake: { woke += 1 })
        keeper.scene(.background)
        expire?()
        keeper.scene(.active)
        #expect(began == 1)
        #expect(ended == [7])
        #expect(woke == 1)
    }
}
