import Testing
import CoreGraphics
@testable import Ace

@Suite struct ComposerFitTests {
    private let fit = ComposerFit(line: 23, inset: 24, minimum: 44)

    @Test func aFocusedEmptyComposerOpensToItsWritingHeight() {
        let empty = fit.height(content: 47, focused: true)
        #expect(empty > fit.height(content: 47, focused: false))
        #expect(empty == 23 * 3 + 24)
        #expect(ComposerFit.card(focused: true, wraps: false))
    }

    @Test func anUnfocusedEmptyComposerIsOneLine() {
        #expect(fit.height(content: 47, focused: false) == 47)
        #expect(fit.height(content: 0, focused: false) == 44)
        #expect(!ComposerFit.card(focused: false, wraps: false))
    }

    @Test func textTallerThanTheWritingHeightKeepsItsOwnHeightUpToTheMax() {
        let fourLines: CGFloat = 23 * 4 + 24
        #expect(fit.height(content: fourLines, focused: true) == fourLines)
        #expect(fit.height(content: fourLines, focused: false) == fourLines)
        let twentyLines: CGFloat = 23 * 20 + 24
        #expect(fit.height(content: twentyLines, focused: true) == 23 * 5 + 24)
        #expect(fit.height(content: twentyLines, focused: false) == 23 * 5 + 24)
    }

    @Test func wrappedTextStaysACardAfterFocusLeaves() {
        #expect(ComposerFit.card(focused: false, wraps: true))
    }

    @Test func accessibilityTypeOpensToFewerLines() {
        let large = ComposerFit(line: 60, inset: 24, minimum: 44, largeType: true)
        #expect(large.height(content: 84, focused: true) == 60 * 2 + 24)
    }
}
