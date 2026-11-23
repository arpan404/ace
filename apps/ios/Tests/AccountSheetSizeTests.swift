import CoreGraphics
import Testing
@testable import Ace

@Suite struct AccountSheetSizeTests {
    @Test func theFirstMeasurementSetsTheHeight() {
        #expect(AccountSheetSize.next(current: 0, measured: 420) == 420)
    }

    @Test func aRowsWordsChangingNeverResizesTheSheet() {
        #expect(AccountSheetSize.next(current: 420, measured: 432) == 420)
        #expect(AccountSheetSize.next(current: 420, measured: 380) == 420)
    }

    @Test func aNewRowGrowsTheSheetOnce() {
        #expect(AccountSheetSize.next(current: 420, measured: 480) == 480)
    }
}
