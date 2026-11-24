import Foundation
import Testing
@testable import Ace

@Suite @MainActor struct BackgroundHoldTests {
    @Test func leavingTheAppHoldsATaskAndReturningReleasesItAndChecksTheSockets() {
        var hold = BackgroundHold(enabled: true)
        #expect(hold.resignActive() == [.beginTask])
        #expect(hold.enteredBackground() == [])
        #expect(hold.becameActive() == [.endTask, .wake])
    }
    @Test func theTaskIsAskedForBeforeTheAppReachesTheBackground() {
        // UIKit grants the assertion asynchronously; asking only once in the background leaves
        // a window where iOS suspends the app first.
        var hold = BackgroundHold(enabled: true)
        #expect(hold.resignActive() == [.beginTask])
        #expect(hold.enteredBackground() == [])
    }
    @Test func withBackgroundRefreshOffNothingIsHeldButTheReturnStillChecksTheSockets() {
        var hold = BackgroundHold(enabled: false)
        #expect(hold.resignActive() == [])
        #expect(hold.enteredBackground() == [])
        #expect(hold.becameActive() == [.wake])
    }
    @Test func aSwitcherPeekThatNeverLeavesTheScreenReleasesTheTaskWithoutWaking() {
        var hold = BackgroundHold(enabled: true)
        #expect(hold.resignActive() == [.beginTask])
        #expect(hold.becameActive() == [.endTask])
    }
    @Test func iOSTakingTheGraceBackEndsTheTaskThenAndTheReturnOnlyWakes() {
        var hold = BackgroundHold(enabled: true)
        _ = hold.resignActive()
        _ = hold.enteredBackground()
        #expect(hold.expired() == [.endTask])
        #expect(hold.expired() == [])
        #expect(hold.becameActive() == [.wake])
    }
    @Test func repeatedResignsHoldOneTask() {
        var hold = BackgroundHold(enabled: true)
        #expect(hold.resignActive() == [.beginTask])
        #expect(hold.resignActive() == [])
    }
    @Test func turningTheSettingOffWhileAwayReleasesTheTask() {
        var hold = BackgroundHold(enabled: true)
        _ = hold.resignActive()
        _ = hold.enteredBackground()
        #expect(hold.setEnabled(false) == [.endTask])
        #expect(hold.becameActive() == [.wake])
    }
    @Test func theKeeperReleasesTheTaskWhenIOSExpiresItBeforeTheAppReturns() {
        var began = 0, ended: [Int] = [], woke = 0
        var expire: (@MainActor () -> Void)?
        let keeper = BackgroundKeeper(enabled: true,
            begin: { handler in began += 1; expire = handler; return 7 }, end: { ended.append($0) }, wake: { woke += 1 })
        keeper.resignActive()
        keeper.enteredBackground()
        expire?()
        #expect(ended == [7])
        keeper.becameActive()
        #expect(began == 1)
        #expect(ended == [7])
        #expect(woke == 1)
    }
}
