import Foundation
import Testing
@testable import Ace

/// Which Suit the phone shows (ADR 0150): the device's pick and one step back, an agent's
/// preview, keep and undo, the theme whenever a Suit can't show, and the last Suit kept for
/// the next launch.
@Suite @MainActor struct SuitLookTests {
    @Test func aPickedSuitShowsOnceReadAndTheLookBeforeItComesBack() throws {
        let model = SuitLookModel(defaults: try suite())
        model.choose("tarn")
        #expect(model.applied == nil)
        model.show(suit("tarn"))
        #expect(model.applied?.id == "tarn")
        model.choose("mizzle")
        // The theme shows until Mizzle is read; Tarn never lingers under its name.
        #expect(model.applied == nil)
        model.revert()
        #expect(model.setting == "tarn")
        #expect(model.applied?.id == "tarn")
        model.choose(nil)
        model.revert()
        #expect(model.setting == "tarn")
    }

    @Test func aSuitThisPhoneCantDrawFallsBackToTheThemeWithTheReason() throws {
        let model = SuitLookModel(defaults: try suite())
        model.choose("loud")
        model.show(suit("loud", unavailable: "Its foreground reads at 1.0:1 in light on this phone; it needs 4.5:1."))
        #expect(model.applied == nil)
        #expect(model.refusal?.reason.hasPrefix("Its foreground") == true)
        model.choose(nil)
        #expect(model.refusal == nil)
    }

    @Test func anAgentsPreviewShowsOverThePickAndEndsBackOnIt() throws {
        let model = SuitLookModel(defaults: try suite())
        model.choose("tarn")
        model.show(suit("tarn"))
        model.hear(.preview("neon"))
        #expect(model.wanted == "neon")
        model.show(suit("neon"))
        #expect(model.applied?.id == "neon")
        model.hear(.none)
        #expect(model.setting == "tarn")
        #expect(model.applied?.id == "tarn")
    }

    @Test func anAgentsKeepIsUndoneOnlyWhileThePersonHasntPickedSinceThen() throws {
        let model = SuitLookModel(defaults: try suite())
        model.choose("tarn")
        model.hear(.keep("neon", keepId: "k1"))
        #expect(model.setting == "neon")
        model.hear(.restore(keepId: "k1"))
        #expect(model.setting == "tarn")

        model.hear(.keep("neon", keepId: "k2"))
        model.choose("mizzle")
        model.hear(.restore(keepId: "k2"))
        #expect(model.setting == "mizzle")
    }

    @Test func theKeptSuitDrawsAtLaunchBeforeAnyMachineAnswers() throws {
        let defaults = try suite()
        let first = SuitLookModel(defaults: defaults)
        first.choose("tarn")
        first.show(suit("tarn"))
        #expect(SuitLookModel(defaults: defaults).applied?.id == "tarn")
        // A preview is never kept for the next launch.
        first.hear(.preview("neon"))
        first.show(suit("neon"))
        #expect(SuitLookModel(defaults: defaults).applied?.id == "tarn")
        first.hear(.none)
        first.choose(nil)
        #expect(SuitLookModel(defaults: defaults).applied == nil)
    }

    @Test func aSuitsColoursReplaceTheThemesAndLetGoWithIt() throws {
        let palette = NativePaletteModel(defaults: try suite())
        let tarn = suit("tarn")
        palette.wear(suit: tarn.pairs)
        #expect(palette.pair(for: "background") == NativePalette.Pair(light: 0x16181B, dark: 0x16181B))
        palette.wear(suit: nil)
        #expect(palette.pair(for: "background") == nil)
    }

    private func suit(_ id: String, unavailable: String? = nil) -> PhoneSuit {
        let roles = ["background": "#16181B", "foreground": "#E7EAEE"]
        return PhoneSuit(
            id: id, name: id, description: "", contentHash: String(repeating: "a", count: 64), schemes: ["dark"],
            colours: ["light": roles, "dark": roles], fonts: .init(ui: nil, prose: nil, mono: nil),
            radius: 1, border: 1, density: nil, stills: .init(light: nil, dark: nil), unavailable: unavailable)
    }

    private func suite() throws -> UserDefaults {
        let name = "SuitLookTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defaults.removePersistentDomain(forName: name)
        return defaults
    }
}
