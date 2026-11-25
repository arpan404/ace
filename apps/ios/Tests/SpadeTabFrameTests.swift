import Testing
@testable import Ace

struct SpadeTabFrameTests {
    @Test func theSpadeTabIsThereAtLaunchWhenItShowedLastTime() {
        // No machine has answered yet: the tab stays as the machines last left it.
        #expect(HomeTabs.showsSpade(answers: [], remembered: true))
        #expect(HomeTabs.showsSpade(answers: [nil, nil], remembered: true))
        #expect(!HomeTabs.showsSpade(answers: [nil], remembered: false))
        // A machine showing Spade shows it, whatever was remembered.
        #expect(HomeTabs.showsSpade(answers: [nil, true], remembered: false))
    }
    @Test func theSpadeTabGoesOnlyOnceEveryMachineHasSaidNo() {
        // One machine saying no while another hasn't answered keeps the tab, and its memory.
        #expect(HomeTabs.showsSpade(answers: [false, nil], remembered: true))
        #expect(HomeTabs.rememberedSpade(answers: [false, nil]) == nil)
        #expect(!HomeTabs.showsSpade(answers: [false, false], remembered: true))
        #expect(HomeTabs.rememberedSpade(answers: [false, false]) == false)
        #expect(HomeTabs.rememberedSpade(answers: [false, true]) == true)
    }
    @Test func glancesHoldThenReturnToRest() {
        for (time, expected) in [
            (0.0, SpadeTabFrame.rest), (0.7, .left), (1.2, .left),
            (1.4, .right), (1.9, .right), (2.2, .rest),
        ] {
            #expect(SpadeTabFrame.sample(at: time).frame == expected)
        }
        let held = SpadeTabFrame.sample(at: 0.7)
        #expect(held.next > 1.2)
        #expect(SpadeTabFrame.sample(at: held.next).frame == .right)
    }

    @Test func oneBriefBlinkOverridesTheLookAndReopensOnTime() {
        let before = SpadeTabFrame.sample(at: 2.7)
        #expect(before.frame == .rest)
        let blink = SpadeTabFrame.sample(at: before.next)
        #expect(blink.frame == .blink)
        #expect(abs(blink.next - before.next - 0.112) < 0.000001)
        #expect(SpadeTabFrame.sample(at: blink.next).frame == .rest)
        #expect(SpadeTabFrame.sample(at: 5.6).frame == .rest)
    }

    @Test func theSameElapsedTimeGivesTheSameFrameAndTheCycleRepeats() {
        for time in [0.3, 0.9, 1.5, 2.8, 3.8, 4.5] {
            let sample = SpadeTabFrame.sample(at: time)
            let repeated = SpadeTabFrame.sample(at: time)
            let nextCycle = SpadeTabFrame.sample(at: time + 5.6)
            #expect(sample.frame == repeated.frame && sample.next == repeated.next)
            #expect(sample.frame == nextCycle.frame)
            #expect(abs(nextCycle.next - sample.next - 5.6) < 0.000001)
        }
    }
}
