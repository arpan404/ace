import Foundation
import Testing
@testable import Ace

/// A streaming answer reaches markit 10 to 20 times a second, never on every delta, and its
/// finished text never waits (`StreamPace`). Time is simulated: no test sleeps.
@Suite struct StreamPaceTests {
    /// Streams a delta every `every` seconds for `seconds`, running each wait the pace asks for
    /// as a timer would, `lateBy` seconds late. Returns what was drawn, with when.
    private func stream(every: TimeInterval, for seconds: TimeInterval, lateBy: TimeInterval = 0,
                        reduceMotion: Bool = false) -> (drawn: [(at: TimeInterval, text: String)], pace: StreamPace, text: String) {
        var pace = StreamPace()
        pace.reduceMotion = reduceMotion
        var drawn: [(at: TimeInterval, text: String)] = []
        var text = ""
        var wake: TimeInterval?
        func take(_ step: StreamPace.Step, at now: TimeInterval) {
            switch step {
            case .show(let shown): drawn.append((now, shown))
            case .wait(let delay): if wake == nil { wake = now + delay }
            case .idle: break
            }
        }
        var now: TimeInterval = 0
        var next: TimeInterval = 0
        while next < seconds {
            if let due = wake, due + lateBy <= next {
                wake = nil
                now = due + lateBy
                take(pace.due(now: now, late: lateBy), at: now)
                continue
            }
            now = next
            text += "word "
            take(pace.push(text, now: now), at: now)
            next += every
        }
        return (drawn, pace, text)
    }

    @Test func theFirstTextOfAStreamShowsAtOnce() {
        var pace = StreamPace()
        #expect(pace.push("Looking", now: 10) == .show("Looking"))
    }

    @Test func deltasArrivingEveryTenMillisecondsDrawAtMostTwentyTimesASecond() {
        let run = stream(every: 0.01, for: 1)
        // 100 deltas arrived; about 20 draws, each at least 50 ms after the one before.
        #expect(run.drawn.count <= 21)
        #expect(run.drawn.count >= 15)
        for (earlier, later) in zip(run.drawn, run.drawn.dropFirst()) {
            #expect(later.at - earlier.at >= StreamPace.fastest - 1e-9)
        }
    }

    @Test func aWaitDrawsTheLatestTextNotTheOneThatAskedForIt() {
        var pace = StreamPace()
        _ = pace.push("One", now: 0)
        #expect(pace.push("One two", now: 0.01) == .wait(0.05 - 0.01))
        // The wait already asked for draws it; no second wait is asked for.
        #expect(pace.push("One two three", now: 0.02) == .idle)
        #expect(pace.due(now: 0.05, late: 0) == .show("One two three"))
        #expect(pace.due(now: 0.06, late: 0) == .idle)
    }

    @Test func aBusyMainThreadSlowsTheStreamToTenUpdatesASecond() {
        let run = stream(every: 0.01, for: 2, lateBy: 0.04)
        for (earlier, later) in zip(run.drawn, run.drawn.dropFirst()).dropFirst() {
            #expect(later.at - earlier.at >= StreamPace.slowest - 1e-9)
        }
        #expect(run.drawn.count <= 21)
    }

    @Test func reduceMotionDrawsTenUpdatesASecond() {
        let run = stream(every: 0.01, for: 1, reduceMotion: true)
        #expect(run.drawn.count <= 11)
        for (earlier, later) in zip(run.drawn, run.drawn.dropFirst()) {
            #expect(later.at - earlier.at >= StreamPace.slowest - 1e-9)
        }
    }

    @Test func finishedTextShowsImmediatelyEvenInsideTheInterval() {
        var pace = StreamPace()
        _ = pace.push("Almost", now: 0)
        #expect(pace.push("Almost done", now: 0.01) == .wait(0.05 - 0.01))
        #expect(pace.finish("Almost done.") == .show("Almost done."))
        // A wait that was already running finds nothing left to draw.
        #expect(pace.due(now: 0.05, late: 0) == .idle)
    }

    @Test func textAlreadyOnScreenIsNotDrawnAgain() {
        var pace = StreamPace()
        _ = pace.push("Same", now: 0)
        #expect(pace.push("Same", now: 1) == .idle)
        #expect(pace.finish("Same") == .idle)
    }

    @Test func aStreamThatPausesShowsItsNextDeltaAtOnce() {
        var pace = StreamPace()
        _ = pace.push("Thinking", now: 0)
        #expect(pace.push("Thinking about it", now: 3) == .show("Thinking about it"))
    }

    @Test func everyDeltaIsEventuallyDrawn() {
        let run = stream(every: 0.013, for: 1)
        var pace = run.pace
        // The stream stops; the last pending wait draws whatever arrived last.
        var final = run.drawn.last?.text
        if case .show(let text) = pace.due(now: 10, late: 0) { final = text }
        #expect(final == run.text)
    }

    @Test func aStreamWhoseTimerWasDroppedDrawsItsNewestTextWhenPickedUpAgain() {
        var pace = StreamPace()
        _ = pace.push("Off", now: 0)
        #expect(pace.push("Off screen", now: 0.01) == .wait(0.05 - 0.01))
        // The view left the screen and dropped its timer; more text arrived meanwhile.
        #expect(pace.push("Off screen and back", now: 0.5) == .idle)
        #expect(pace.due(now: 2, late: 0) == .show("Off screen and back"))
    }
}
