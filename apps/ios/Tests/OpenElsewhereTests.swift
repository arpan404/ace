import Testing
@testable import Ace

struct OpenElsewhereTests {
    @Test func openingAThreadWaitsOnlyForAListThatHasNotArrived() {
        #expect(OpenElsewhere.of(paired: true, listed: true, loaded: true) == .opened)
        #expect(OpenElsewhere.of(paired: true, listed: false, loaded: false) == .waiting)
        // A loaded list without the thread (archived) never catches up: say so, don't promise.
        #expect(OpenElsewhere.of(paired: true, listed: false, loaded: true) == .missing)
        #expect(OpenElsewhere.of(paired: false, listed: false, loaded: false) == .unpaired)
    }

    @Test func aListWithOlderPagesLeftDoesNotSayAThreadIsGoneUntilItIsReadById() {
        // The thread may sit past the loaded window: keep waiting until its id is read.
        #expect(OpenElsewhere.of(paired: true, listed: false, loaded: true, complete: false, located: nil) == .waiting)
        #expect(OpenElsewhere.of(paired: true, listed: false, loaded: true, complete: false, located: false) == .missing)
        // Found by id: it opens though the list doesn't hold it.
        #expect(OpenElsewhere.of(paired: true, listed: false, loaded: true, complete: false, located: true) == .opened)
        // Before the live list arrives, nothing is known whatever the id read said.
        #expect(OpenElsewhere.of(paired: true, listed: false, loaded: false, complete: false, located: false) == .waiting)
    }
}
