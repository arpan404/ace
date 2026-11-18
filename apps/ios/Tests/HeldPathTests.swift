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
}
