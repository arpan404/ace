import Foundation
import Testing
@testable import Ace

@Suite struct ActivityTimeTests {
    private let now = Date(timeIntervalSince1970: 1_000_000)
    private let english = Locale(identifier: "en_US")

    @Test func aWorkingStretchUnderAMinuteOrAheadOfThePhoneShowsNoAge() {
        #expect(ActivityTime.elapsed(since: now.addingTimeInterval(-30), now: now, locale: english) == nil)
        #expect(ActivityTime.elapsed(since: now.addingTimeInterval(5), now: now, locale: english) == nil)
    }
    @Test func aWorkingStretchReadsItsLargestWholeUnit() {
        #expect(ActivityTime.elapsed(since: now.addingTimeInterval(-12 * 60 - 50), now: now, locale: english) == "12m")
        #expect(ActivityTime.elapsed(since: now.addingTimeInterval(-3 * 3600 - 59 * 60), now: now, locale: english) == "3h")
        #expect(ActivityTime.elapsed(since: now.addingTimeInterval(-2 * 86_400 - 3600), now: now, locale: english) == "2d")
    }
    @Test func aRowAtRestReadsNowThenItsAgeThenItsDateAfterAWeek() {
        #expect(ActivityTime.age(since: now.addingTimeInterval(-20), now: now, locale: english) == "now")
        #expect(ActivityTime.age(since: now.addingTimeInterval(-9 * 60), now: now, locale: english) == "9m")
        #expect(ActivityTime.age(since: now.addingTimeInterval(-8 * 86_400), now: now, locale: english) == "Jan 4")
    }
    @Test func workUnderWayCountsToTheSecondAsTheDesktopRowDoes() {
        #expect(ActivityTime.running(since: now.addingTimeInterval(-38), now: now) == "38s")
        #expect(ActivityTime.running(since: now.addingTimeInterval(-94), now: now) == "1m 34s")
        #expect(ActivityTime.running(since: now.addingTimeInterval(-3720), now: now) == "1h 2m")
        // A daemon clock slightly ahead never reads as negative time.
        #expect(ActivityTime.running(since: now.addingTimeInterval(4), now: now) == "0s")
    }
    @Test func aMomentRowReadsOneTimeOrTheSpanItCovered() {
        let utc = TimeZone(identifier: "UTC")!
        let at = Date(timeIntervalSince1970: 1_763_285_000).timeIntervalSince1970 * 1000
        let single = EventClock.words(at: at, locale: english, timeZone: utc)
        #expect(single.contains(":"))
        // No end, an end before it, or one inside the same minute: the one time.
        #expect(EventClock.words(at: at, until: 0, locale: english, timeZone: utc) == single)
        #expect(EventClock.words(at: at, until: at + 10_000, locale: english, timeZone: utc) == single)
        // Back-to-back restarts or a limit's wait: from its start to its end, said once.
        let span = EventClock.words(at: at, until: at + 7 * 60_000, locale: english, timeZone: utc)
        #expect(span != single)
        #expect(span.hasPrefix(single.components(separatedBy: " ").first ?? single))
        #expect(span.contains("–"))
        #expect(EventClock.words(at: 0, locale: english, timeZone: utc) == "")
    }
    private func command(settled: Bool, startedAt: Double?, awaiting: Bool? = nil) -> StepLine {
        StepLine(icon: "command", verb: settled ? "Ran" : "Running", target: "bun run lint", note: "", settled: settled,
                 failed: false, needsYou: false, added: nil, removed: nil, awaiting: awaiting, startedAt: startedAt)
    }
    @Test func aStepInFlightCountsUpFromItsStartAndShimmersUnlessMotionIsReduced() {
        let started = now.addingTimeInterval(-7).timeIntervalSince1970 * 1000
        let running = StepInFlight(step: command(settled: false, startedAt: started))
        #expect(running.elapsed(now: now) == "7s")
        #expect(running.elapsed(now: now.addingTimeInterval(87)) == "1m 34s")
        #expect(running.shimmers(reduceMotion: false))
        #expect(!running.shimmers(reduceMotion: true))
    }
    @Test func aStepThatSettledOrWaitsOnApprovalNeitherShimmersNorCounts() {
        let started = now.addingTimeInterval(-7).timeIntervalSince1970 * 1000
        for step in [command(settled: true, startedAt: started), command(settled: false, startedAt: started, awaiting: true)] {
            #expect(StepInFlight(step: step).elapsed(now: now) == nil)
            #expect(!StepInFlight(step: step).shimmers(reduceMotion: false))
        }
        // A running step whose start the bridge didn't send still shimmers, with no time.
        let unknown = StepInFlight(step: command(settled: false, startedAt: nil))
        #expect(unknown.elapsed(now: now) == nil)
        #expect(unknown.shimmers(reduceMotion: false))
    }
    @Test func theShimmerBandCrossesTheWordsOncePerPeriod() {
        let start = Date(timeIntervalSinceReferenceDate: 100 * Shimmer.period)
        #expect(Shimmer.phase(at: start) == 0)
        #expect(abs(Shimmer.phase(at: start.addingTimeInterval(Shimmer.period / 2)) - 0.5) < 0.0001)
        #expect(Shimmer.phase(at: start.addingTimeInterval(Shimmer.period)) == 0)
    }
}
