import Foundation
import Testing
@testable import Ace

@Suite @MainActor struct BackgroundHoldTests {
    @Test func leavingTheAppHoldsATaskAndReturningReleasesItAndChecksTheSockets() {
        var hold = BackgroundHold(enabled: true)
        #expect(hold.resignActive(connections: ["ready"]) == [.beginTask])
        #expect(hold.enteredBackground() == [])
        #expect(hold.becameActive() == [.endTask, .wake])
    }
    @Test func theTaskIsAskedForBeforeTheAppReachesTheBackground() {
        // UIKit grants the assertion asynchronously; asking only once in the background leaves
        // a window where iOS suspends the app first.
        var hold = BackgroundHold(enabled: true)
        #expect(hold.resignActive(connections: ["ready"]) == [.beginTask])
        #expect(hold.enteredBackground() == [])
    }
    @Test func withBackgroundRefreshOffNothingIsHeldButTheReturnStillChecksTheSockets() {
        var hold = BackgroundHold(enabled: false)
        #expect(hold.resignActive(connections: ["ready"]) == [])
        #expect(hold.enteredBackground() == [])
        #expect(hold.becameActive() == [.wake])
    }
    @Test func aSwitcherPeekThatNeverLeavesTheScreenReleasesTheTaskWithoutWaking() {
        var hold = BackgroundHold(enabled: true)
        #expect(hold.resignActive(connections: ["ready"]) == [.beginTask])
        #expect(hold.becameActive() == [.endTask])
    }
    @Test func iOSTakingTheGraceBackEndsTheTaskThenAndTheReturnOnlyWakes() {
        var hold = BackgroundHold(enabled: true)
        _ = hold.resignActive(connections: ["ready"])
        _ = hold.enteredBackground()
        #expect(hold.expired() == [.endTask])
        #expect(hold.expired() == [])
        #expect(hold.becameActive() == [.wake])
    }
    @Test func withNoMachineConnectedNoBackgroundTimeIsAskedFor() {
        // The pairing screen of a fresh install, or every machine unreachable.
        var hold = BackgroundHold(enabled: true)
        #expect(hold.resignActive(connections: []) == [])
        #expect(hold.enteredBackground() == [])
        #expect(hold.becameActive() == [.wake])
    }
    @Test func aMachineStillConnectingWhenTheAppLeavesKeepsBackgroundTime() {
        for state in ["connecting", "starting", "reconnecting"] {
            var hold = BackgroundHold(enabled: true)
            #expect(hold.resignActive(connections: ["offline", state]) == [.beginTask], "\(state)")
        }
    }
    @Test func machinesThatAreOfflineOrRefusedHoldNoBackgroundTime() {
        // No socket is being worked on: offline waits for the network, fatal for the person.
        var hold = BackgroundHold(enabled: true)
        #expect(hold.resignActive(connections: ["offline", "fatal"]) == [])
    }
    @Test func aSocketThatStartsAfterTheAppResignsTakesTheHoldThen() {
        var hold = BackgroundHold(enabled: true)
        #expect(hold.resignActive(connections: []) == [])
        #expect(hold.connectionsChanged(["offline"]) == [])
        #expect(hold.connectionsChanged(["connecting"]) == [.beginTask])
        #expect(hold.connectionsChanged(["ready"]) == [])
        #expect(hold.becameActive() == [.endTask])
    }
    @Test func aConnectionChangeWhileOnScreenHoldsNothing() {
        var hold = BackgroundHold(enabled: true)
        #expect(hold.connectionsChanged(["connecting"]) == [])
        _ = hold.resignActive(connections: [])
        _ = hold.becameActive()
        #expect(hold.connectionsChanged(["ready"]) == [])
    }
    @Test func afterIOSTakesTheGraceBackALaterConnectionDoesNotAskAgain() {
        var hold = BackgroundHold(enabled: true)
        _ = hold.resignActive(connections: ["ready"])
        _ = hold.enteredBackground()
        _ = hold.expired()
        #expect(hold.connectionsChanged(["reconnecting"]) == [])
        #expect(hold.becameActive() == [.wake])
        #expect(hold.resignActive(connections: ["ready"]) == [.beginTask])
    }
    @Test func repeatedResignsHoldOneTask() {
        var hold = BackgroundHold(enabled: true)
        #expect(hold.resignActive(connections: ["ready"]) == [.beginTask])
        #expect(hold.resignActive(connections: ["ready"]) == [])
    }
    @Test func turningTheSettingOffWhileAwayReleasesTheTask() {
        var hold = BackgroundHold(enabled: true)
        _ = hold.resignActive(connections: ["ready"])
        _ = hold.enteredBackground()
        #expect(hold.setEnabled(false) == [.endTask])
        #expect(hold.becameActive() == [.wake])
    }
    @Test func theKeeperReleasesTheTaskWhenIOSExpiresItBeforeTheAppReturns() {
        var began = 0, ended: [Int] = [], woke = 0
        var expire: (@MainActor () -> Void)?
        let keeper = BackgroundKeeper(enabled: true, connections: { ["ready"] },
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
    @Test func theKeeperTakesTheHoldWhenAMachineStartsConnectingAfterTheAppResigns() {
        var began = 0
        var states: [String] = []
        let keeper = BackgroundKeeper(enabled: true, connections: { states },
            begin: { _ in began += 1; return 7 }, end: { _ in }, wake: {})
        keeper.resignActive()
        states = ["connecting"]
        keeper.connectionsChanged()
        #expect(began == 1)
    }
    @Test func theKeeperAsksForNothingWhileNoMachineSocketIsWorking() {
        var began = 0
        let keeper = BackgroundKeeper(enabled: true, connections: { ["fatal"] },
            begin: { _ in began += 1; return 7 }, end: { _ in }, wake: {})
        keeper.resignActive()
        keeper.enteredBackground()
        #expect(began == 0)
    }
}
