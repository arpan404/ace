import Foundation
import Testing
@testable import Ace

/// The browser's picture-in-picture through AVKit's asynchronous start and stop: it never outlives
/// what the rule allows, and a stream kept open for it never outlives it.
@Suite struct PipLifecycleTests {
    let view = UUID()

    @Test func leavingTheBrowserFloatsThePageAndKeepsItsStream() {
        var pip = PipLifecycle()
        #expect(pip.leave(view, eligible: true) == [.start])
        #expect(pip.floating && !pip.active)
        #expect(pip.willStart(view, eligible: true).isEmpty)
        #expect(pip.didStart(view, eligible: true).isEmpty)
        #expect(pip.active)
        // The person closes the float: the stream kept for it closes.
        #expect(pip.ended(view, restore: false, onScreen: false) == [.closeStream])
        #expect(pip.kept == nil)
    }

    @Test func leavingWhenTheRuleDoesntHoldClosesTheStream() {
        var pip = PipLifecycle()
        #expect(pip.leave(view, eligible: false) == [.closeStream])
        #expect(!pip.floating)
    }

    @Test func aPauseBeforeAVKitStartsCancelsItAndClosesTheKeptStreamAtOnce() {
        var pip = PipLifecycle()
        _ = pip.leave(view, eligible: true)
        // The browser pauses before AVKit's will-start: not yet active, still stopped.
        #expect(pip.recheck(eligible: false) == [.stop, .closeStream])
        // AVKit starts it anyway, late: stopped again, and the closed stream isn't closed twice.
        #expect(pip.willStart(view, eligible: false) == [.stop])
        #expect(pip.didStart(view, eligible: false) == [.stop])
        #expect(!pip.active)
        #expect(pip.ended(view, restore: false, onScreen: false).isEmpty)
    }

    @Test func aPauseBetweenWillStartAndDidStartStopsTheLateStart() {
        var pip = PipLifecycle()
        _ = pip.leave(view, eligible: true)
        #expect(pip.willStart(view, eligible: true).isEmpty)
        #expect(pip.recheck(eligible: false) == [.stop, .closeStream])
        #expect(pip.didStart(view, eligible: true) == [.stop])
        #expect(!pip.active)
    }

    @Test func aStartThatIsNoLongerAllowedWhenItLandsIsStopped() {
        var pip = PipLifecycle()
        _ = pip.leave(view, eligible: true)
        #expect(pip.willStart(view, eligible: true).isEmpty)
        #expect(pip.didStart(view, eligible: false) == [.stop, .closeStream])
        #expect(!pip.active)
    }

    @Test func callbacksForAnEarlierViewChangeNothingButAreStopped() {
        var pip = PipLifecycle()
        let earlier = UUID()
        _ = pip.leave(view, eligible: true)
        #expect(pip.didStart(earlier, eligible: true) == [.stop])
        #expect(pip.failed(earlier).isEmpty)
        #expect(pip.ended(earlier, restore: false, onScreen: false).isEmpty)
        #expect(pip.kept == view && pip.floating)
    }

    @Test func aFloatAVKitCantStartClosesTheKeptStream() {
        var pip = PipLifecycle()
        _ = pip.leave(view, eligible: true)
        #expect(pip.failed(view) == [.closeStream])
        #expect(!pip.floating)
    }

    @Test func leavingTheAppFloatsWithoutKeepingAndADismissMutesThePage() {
        var pip = PipLifecycle()
        #expect(pip.willStart(view, eligible: true).isEmpty)
        #expect(pip.didStart(view, eligible: true).isEmpty)
        #expect(pip.kept == nil)
        #expect(pip.ended(view, restore: false, onScreen: false) == [.mute])
        // Back in the app instead: the Browser shows the page, its sound stays.
        #expect(pip.willStart(view, eligible: true).isEmpty)
        _ = pip.didStart(view, eligible: true)
        #expect(pip.ended(view, restore: false, onScreen: true).isEmpty)
    }

    @Test func theBrowserShowingAgainEndsTheFloatAndKeepsTheStreamForItself() {
        var pip = PipLifecycle()
        _ = pip.leave(view, eligible: true)
        #expect(pip.willStart(view, eligible: true).isEmpty)
        _ = pip.didStart(view, eligible: true)
        #expect(pip.reset() == [.stop])
        #expect(pip.kept == nil)
        #expect(pip.ended(view, restore: true, onScreen: true).isEmpty)
    }
}
