import Testing
@testable import Ace

/// A screen waiting for a checkout's building index spends one deadline: every request and sleep
/// takes only what is left, and an expired wait offers no pause at all.
@Suite struct IndexWaitTests {
    private let start = ContinuousClock.now

    @Test func aFreshWaitOffersTheWholeRetryInterval() {
        let wait = IndexWait(deadline: start.advanced(by: .seconds(8)), now: { start })
        #expect(wait.remaining == .seconds(8))
        #expect(wait.pause() == .milliseconds(300))
    }

    @Test func aWaitNearItsDeadlinePausesOnlyWhatIsLeft() {
        let later = start.advanced(by: .seconds(8) - .milliseconds(120))
        let wait = IndexWait(deadline: start.advanced(by: .seconds(8)), now: { later })
        #expect(wait.pause() == .milliseconds(120))
    }

    @Test func anExpiredWaitOffersNoPause() {
        let ended = start.advanced(by: .seconds(8))
        let wait = IndexWait(deadline: ended, now: { ended })
        #expect(wait.remaining == .zero)
        #expect(wait.pause() == nil)

        let past = IndexWait(deadline: ended, now: { ended.advanced(by: .seconds(1)) })
        #expect(past.pause() == nil)
    }
}
