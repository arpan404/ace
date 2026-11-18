import CoreGraphics
import Testing
@testable import Ace

/// A reopened stack shows its root before the pages it had pushed.
struct HeldPathTests {
    @Test func theSavedPagesWaitUntilTheRootHasBeenShown() {
        var held = HeldPath()
        #expect(held.shown([1, 2]).isEmpty)
        held.release()
        #expect(held.shown([1, 2]) == [1, 2])
    }

    @Test func theStackShowingOnlyItsRootNeverWipesTheSavedPages() {
        let held = HeldPath()
        var saved = [1, 2]
        held.write([], into: &saved)
        #expect(saved == [1, 2])
    }

    @Test func oncePushedThePersonsNavigationIsSaved() {
        var held = HeldPath()
        var saved = [1, 2]
        held.release()
        held.write([1], into: &saved)
        #expect(saved == [1])
        held.write([1, 3], into: &saved)
        #expect(saved == [1, 3])
    }

    @Test func onlyTheRootsFirstRealLayoutLetsThePagesGoOn() {
        var held = HeldPath()
        let answers = [CGSize.zero, CGSize(width: 390, height: 0), CGSize(width: 390, height: 844), CGSize(width: 390, height: 700)]
            .map { held.rootLaidOut($0) }
        #expect(answers == [false, false, true, false])
    }

    @Test func aRowTappedWhileThePagesAreHeldOpensOnlyThatPage() {
        var held = HeldPath()
        var saved = ["A"]
        held.open("A", on: &saved)
        #expect(saved == ["A"])
        #expect(held.shown(saved) == ["A"])
    }

    @Test func aRowTappedWhileOtherPagesAreHeldReplacesThem() {
        var held = HeldPath()
        var saved = ["A", "B"]
        held.open("C", on: &saved)
        #expect(held.shown(saved) == ["C"])
    }

    @Test func aPageOpenedAfterTheHandOverGoesOnTop() {
        var held = HeldPath()
        var saved = ["A"]
        held.release()
        held.open("B", on: &saved)
        #expect(saved == ["A", "B"])
    }
}
