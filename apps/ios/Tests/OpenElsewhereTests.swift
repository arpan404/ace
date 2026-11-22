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
}
