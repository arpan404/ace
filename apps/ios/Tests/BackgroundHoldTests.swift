import Foundation
import Testing
import UIKit
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
}

/// The keeper as the app runs it: UIKit's lifecycle notifications on a test center, and a fake
/// background-task API in place of `UIApplication`'s.
@Suite @MainActor struct BackgroundKeeperTests {
    @MainActor final class FakeTasks {
        var began = 0, ended: [Int] = [], woke = 0
        var expire: (@MainActor () -> Void)?
        var states = ["ready"]
        let center = NotificationCenter()
        lazy var keeper: BackgroundKeeper = {
            let keeper = BackgroundKeeper(enabled: true, connections: { [unowned self] in states },
                begin: { [unowned self] handler in began += 1; expire = handler; return 7 },
                end: { [unowned self] in ended.append($0) }, wake: { [unowned self] in woke += 1 })
            keeper.observe(center)
            return keeper
        }()
        init(states: [String] = ["ready"]) { self.states = states; _ = keeper }
        func post(_ name: Notification.Name) { center.post(name: name, object: nil) }
    }

    @Test func leavingTheAppAndComingBackHoldsOnceReleasesOnceAndWakesOnce() {
        let app = FakeTasks()
        app.post(UIApplication.willResignActiveNotification)
        #expect(app.began == 1)
        app.post(UIApplication.didEnterBackgroundNotification)
        app.post(UIApplication.didBecomeActiveNotification)
        #expect(app.began == 1)
        #expect(app.ended == [7])
        #expect(app.woke == 1)
    }
    @Test func resigningAndReturningWithoutLeavingTheScreenReleasesTheHoldWithoutWaking() {
        let app = FakeTasks()
        app.post(UIApplication.willResignActiveNotification)
        app.post(UIApplication.didBecomeActiveNotification)
        #expect(app.began == 1)
        #expect(app.ended == [7])
        #expect(app.woke == 0)
    }
    @Test func theKeeperReleasesTheTaskWhenIOSExpiresItBeforeTheAppReturns() {
        let app = FakeTasks()
        app.post(UIApplication.willResignActiveNotification)
        app.post(UIApplication.didEnterBackgroundNotification)
        app.expire?()
        #expect(app.ended == [7])
        app.post(UIApplication.didBecomeActiveNotification)
        #expect(app.began == 1)
        #expect(app.ended == [7])
        #expect(app.woke == 1)
    }
    @Test func theKeeperTakesTheHoldWhenAMachineStartsConnectingAfterTheAppResigns() {
        let app = FakeTasks(states: [])
        app.post(UIApplication.willResignActiveNotification)
        #expect(app.began == 0)
        app.states = ["connecting"]
        app.keeper.connectionsChanged()
        #expect(app.began == 1)
    }
    @Test func theKeeperAsksForNothingWhileNoMachineSocketIsWorking() {
        let app = FakeTasks(states: ["fatal"])
        app.post(UIApplication.willResignActiveNotification)
        app.post(UIApplication.didEnterBackgroundNotification)
        #expect(app.began == 0)
    }
}
