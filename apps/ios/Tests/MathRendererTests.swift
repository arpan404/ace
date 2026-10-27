import Testing
import UIKit
@testable import Ace

/// The KaTeX page typesets a finished answer's formulas in the app (`MathRenderer`): a good one
/// comes back as an image sitting on its baseline, one KaTeX refuses comes back as nothing, and a
/// request given up on (its row scrolled away) never counts against the formula.
@MainActor @Suite(.serialized) struct MathRendererTests {
    @Test func aFormulaTypesetsWithItsBaselineInsideIt() async throws {
        let span = MathSpan(tex: "\\frac{a}{b} + x^2", display: false, text: "a/b + x²")
        let image = try #require(await MathRenderer.shared.render(span, size: 17))
        #expect(image.image.size.width > 10)
        #expect(image.baseline > 0 && image.baseline < image.image.size.height)
        #expect(MathRenderer.shared.cached(span, size: 17) != nil)
    }

    @Test func aFormulaKaTeXRefusesKeepsItsTextForm() async {
        // A link is never trusted in agent TeX: KaTeX refuses it, so the text form stays.
        let span = MathSpan(tex: "\\href{https://example.com}{x}", display: false, text: "x")
        #expect(await MathRenderer.shared.render(span, size: 17) == nil)
    }

    @Test func aRequestGivenUpOnDoesntCountAgainstTheFormula() async throws {
        let span = MathSpan(tex: "\\sqrt{2} \\cdot \\pi", display: true, text: "√2 · π")
        let abandoned = Task { await MathRenderer.shared.render(span, size: 19) }
        abandoned.cancel()
        _ = await abandoned.value
        // Asked again for real, it typesets: being given up on wasn't remembered as a refusal.
        #expect(await MathRenderer.shared.render(span, size: 19) != nil)
    }
}
