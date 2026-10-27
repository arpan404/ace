import Testing
@testable import Ace

/// A finished answer's formulas, as the bridge marks them (`mathSpans` in `@ace/ui-core`), reach
/// the prose in order, and where one can't be typeset its text form reads in its place.
@MainActor @Suite struct MathMarkersTests {
    private let math = [MathSpan(tex: "\\sigma^2", display: false, text: "σ²"), MathSpan(tex: "\\mu", display: false, text: "μ")]

    @Test func proseAndFormulasComeApartInOrder() {
        #expect(MathMarkers.pieces("Spread \u{E000}0\u{E001}, mean \u{E000}1\u{E001}.") ==
                [.prose("Spread "), .formula(0), .prose(", mean "), .formula(1), .prose(".")])
    }

    @Test func aHeadingOrListReadsEachFormulaInItsTextForm() {
        #expect(MathMarkers.plain("Spread \u{E000}0\u{E001} about \u{E000}1\u{E001}", math) == "Spread σ² about μ")
        #expect(MathMarkers.plain("No math here", math) == "No math here")
    }

    @Test func formulasTypesetAtTheReadersTextSize() {
        #expect(MathMarkers.size(.accessibility3) > MathMarkers.size(.large))
    }
}
