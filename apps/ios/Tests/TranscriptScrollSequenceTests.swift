import Testing
@testable import Ace

@Suite struct TranscriptScrollSequenceTests {
    /// Feeds `events` in order and returns every action, in order.
    private func run(_ sequence: inout TranscriptScrollSequence, _ events: TranscriptScrollSequence.Event...)
        -> [TranscriptScrollSequence.Action] {
        events.flatMap { sequence.handle($0) }
    }

    private func held(_ sequence: inout TranscriptScrollSequence) -> Bool {
        sequence.windowChange(movesOffset: { true })
    }

    @Test func aWindowChangeThatMovesTheOffsetWaitsWhileAFingerIsDown() {
        var sequence = TranscriptScrollSequence()
        _ = sequence.handle(.touchDown)

        #expect(held(&sequence))
    }

    @Test func aWindowChangeAtRestLandsAtOnce() {
        var sequence = TranscriptScrollSequence()

        #expect(!held(&sequence))
    }

    @Test func aWindowChangeThatMovesNothingNeverWaits() {
        var sequence = TranscriptScrollSequence()
        _ = sequence.handle(.touchDown)

        let held = sequence.windowChange(movesOffset: { false })

        #expect(!held)
    }

    @Test func aTapThatLiftsLandsTheHeldChangeAndReportsItsGeometryBeforeTheFeedHearsIdle() {
        var sequence = TranscriptScrollSequence()
        _ = sequence.handle(.touchDown)
        _ = held(&sequence)

        let actions = sequence.handle(.touchUp(scrolling: false))

        #expect(actions == [.land, .report, .phase(old: .tracking, new: .idle)])
    }

    @Test func aFlingComingToRestLandsTheHeldChangeBeforeIdle() {
        var sequence = TranscriptScrollSequence()
        _ = run(&sequence, .touchDown, .dragBegan)
        _ = held(&sequence)

        let lifted = run(&sequence, .dragEnded(decelerates: true), .touchUp(scrolling: true))
        let rested = sequence.handle(.decelerationEnded)

        #expect(lifted == [.phase(old: .interacting, new: .decelerating)])
        #expect(rested == [.land, .report, .phase(old: .decelerating, new: .idle)])
    }

    @Test func aSupersededChangeThatMovesNothingIsNotLandedLater() {
        var sequence = TranscriptScrollSequence()
        _ = sequence.handle(.touchDown)
        _ = held(&sequence)
        _ = sequence.windowChange(movesOffset: { false })

        #expect(sequence.handle(.touchUp(scrolling: false)) == [.phase(old: .tracking, new: .idle)])
    }

    @Test func anAnimatedJumpLandsTheHeldChangeBeforeItPicksItsTarget() {
        var sequence = TranscriptScrollSequence()
        _ = run(&sequence, .touchDown, .dragBegan, .dragEnded(decelerates: true))
        _ = held(&sequence)

        let starting = sequence.handle(.animationStarting)
        let started = sequence.handle(.animationStarted)
        let ended = sequence.handle(.animationEnded)

        #expect(starting == [.land, .report])
        #expect(started == [.phase(old: .decelerating, new: .animating)])
        #expect(ended == [.phase(old: .animating, new: .idle)])
    }

    @Test func anAnimatedJumpWithNothingHeldLandsNothing() {
        var sequence = TranscriptScrollSequence()

        #expect(sequence.handle(.animationStarting).isEmpty)
    }

    @Test func aTapDuringTheFeedsAnimationLeavesItAnimatingUntilItEnds() {
        var sequence = TranscriptScrollSequence()
        _ = sequence.handle(.animationStarted)

        let down = sequence.handle(.touchDown)
        let up = sequence.handle(.touchUp(scrolling: false))
        let ended = sequence.handle(.animationEnded)

        #expect(down.isEmpty)
        #expect(!up.contains { if case .phase = $0 { true } else { false } })
        #expect(ended == [.phase(old: .animating, new: .idle)])
    }

    @Test func anAnimationEndingUnderAFingerLandsTheHeldChangeBeforeIdleOnceTheFingerLifts() {
        var sequence = TranscriptScrollSequence()
        _ = run(&sequence, .animationStarted, .touchDown)
        #expect(held(&sequence))

        let ended = sequence.handle(.animationEnded)
        let up = sequence.handle(.touchUp(scrolling: false))

        #expect(ended.isEmpty)
        #expect(up == [.land, .report, .phase(old: .animating, new: .idle)])
    }

    @Test func aFingerLiftingMidAnimationLeavesTheHeldChangeWaitingForTheAnimationsEnd() {
        var sequence = TranscriptScrollSequence()
        _ = run(&sequence, .animationStarted, .touchDown)
        #expect(held(&sequence))

        let up = sequence.handle(.touchUp(scrolling: false))
        let ended = sequence.handle(.animationEnded)

        #expect(!up.contains(.land))
        #expect(!up.contains { if case .phase = $0 { true } else { false } })
        #expect(ended == [.land, .report, .phase(old: .animating, new: .idle)])
    }

    @Test func aChangeHeldUnderATapStillWaitsForTheAnimationWhenAnotherArrivesAfterTheLift() {
        var sequence = TranscriptScrollSequence()
        _ = run(&sequence, .animationStarted, .touchDown)
        _ = held(&sequence)
        _ = sequence.handle(.touchUp(scrolling: false))

        #expect(held(&sequence))
    }

    @Test func anAnimationATapStoppedWithoutReportingItsEndEndsWhenOverdue() {
        var sequence = TranscriptScrollSequence()
        _ = run(&sequence, .animationStarted, .touchDown)

        let up = sequence.handle(.touchUp(scrolling: false))
        guard case .checkAnimation(let generation) = up.last else {
            Issue.record("no check was asked for: \(up)")
            return
        }

        #expect(sequence.handle(.animationOverdue(generation)) == [.phase(old: .animating, new: .idle)])
    }

    @Test func anOverdueCheckFromAnEarlierAnimationLeavesTheNextOneRunning() {
        var sequence = TranscriptScrollSequence()
        _ = run(&sequence, .animationStarted, .touchDown)
        let up = sequence.handle(.touchUp(scrolling: false))
        _ = run(&sequence, .animationEnded, .animationStarted)
        guard case .checkAnimation(let stale) = up.last else {
            Issue.record("no check was asked for: \(up)")
            return
        }

        #expect(sequence.handle(.animationOverdue(stale)).isEmpty)
        #expect(sequence.phase == .animating)
    }

    @Test func aDragDuringTheFeedsAnimationTakesTheScroll() {
        var sequence = TranscriptScrollSequence()
        _ = run(&sequence, .animationStarted, .touchDown)

        #expect(sequence.handle(.dragBegan) == [.phase(old: .animating, new: .interacting)])
        #expect(sequence.handle(.animationEnded).isEmpty)
    }

    @Test func aTouchThatStopsAFlingTracksUntilItLifts() {
        var sequence = TranscriptScrollSequence()
        _ = run(&sequence, .touchDown, .dragBegan, .dragEnded(decelerates: true), .touchUp(scrolling: true))

        let down = sequence.handle(.touchDown)
        let stopped = sequence.handle(.decelerationEnded)
        let up = sequence.handle(.touchUp(scrolling: false))

        #expect(down == [.phase(old: .decelerating, new: .tracking)])
        #expect(stopped.isEmpty)
        #expect(up == [.phase(old: .tracking, new: .idle)])
    }

    @Test func aTouchThatCatchesAFlingStillDeceleratingAsItLiftsRestsWhenTheFlingEnds() {
        var sequence = TranscriptScrollSequence()
        _ = run(&sequence, .touchDown, .dragBegan, .dragEnded(decelerates: true), .touchUp(scrolling: true))
        _ = sequence.handle(.touchDown)
        _ = held(&sequence)

        let up = sequence.handle(.touchUp(scrolling: true))
        let rested = sequence.handle(.decelerationEnded)

        #expect(up.isEmpty)
        #expect(rested == [.land, .report, .phase(old: .tracking, new: .idle)])
    }

    @Test func aSecondFingerDuringADragChangesNothing() {
        var sequence = TranscriptScrollSequence()
        _ = run(&sequence, .touchDown, .dragBegan)

        #expect(sequence.handle(.touchDown).isEmpty)
        #expect(sequence.phase == .interacting)
    }

    @Test func anAssistivePageIsTheReadersScrollAndLandsWhatItHeldAsItEnds() {
        var sequence = TranscriptScrollSequence()
        let began = sequence.handle(.assistiveBegan)
        _ = held(&sequence)

        #expect(began == [.phase(old: .idle, new: .interacting)])
        #expect(sequence.handle(.assistiveEnded) == [.land, .report, .phase(old: .interacting, new: .idle)])
    }
}
