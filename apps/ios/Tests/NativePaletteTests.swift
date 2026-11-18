import Foundation
import Testing
@testable import Ace

/// The native custom palette: saves update the live token resolution, resets restore
/// the shared defaults, and malformed persisted values fall back to empty.
@Suite @MainActor struct NativePaletteTests {
    @Test func savedPaletteChangesLiveResolutionAndResetRestoresDefaults() throws {
        let defaults = try suite()
        let model = NativePaletteModel(defaults: defaults)
        NativePaletteBridge.model = model
        defer { NativePaletteBridge.model = nil }

        #expect(model.palette == NativePalette())
        #expect(NativePaletteBridge.pair(for: "background", light: 0xFFFFFF, dark: 0x0A0A0B) == NativePalette.Pair(light: 0xFFFFFF, dark: 0x0A0A0B))

        try model.save(NativePalette(colours: ["background": NativePalette.Pair(light: 0x112233, dark: 0x445566)]))
        #expect(NativePaletteBridge.pair(for: "background", light: 0xFFFFFF, dark: 0x0A0A0B) == NativePalette.Pair(light: 0x112233, dark: 0x445566))
        // Untouched keys keep resolving to the passed token defaults.
        #expect(NativePaletteBridge.pair(for: "accent", light: 0x3065CC, dark: 0x7AA2F7) == NativePalette.Pair(light: 0x3065CC, dark: 0x7AA2F7))

        model.reset()
        #expect(model.palette == NativePalette())
        #expect(NativePaletteBridge.pair(for: "background", light: 0xFFFFFF, dark: 0x0A0A0B) == NativePalette.Pair(light: 0xFFFFFF, dark: 0x0A0A0B))
    }

    @Test func savedPaletteSurvivesRelaunch() throws {
        let defaults = try suite()
        let saved = NativePalette(colours: ["accent": NativePalette.Pair(light: 0x010203, dark: 0x040506)])
        try NativePaletteModel(defaults: defaults).save(saved)
        #expect(NativePaletteModel(defaults: defaults).palette == saved)
    }

    @Test func semanticColoursAreRejected() throws {
        let defaults = try suite()
        let model = NativePaletteModel(defaults: defaults)
        for key in ["needsYou", "working", "status", "decoration", "glass", "needsYouSurface", "diffAdd"] {
            do {
                try model.save(NativePalette(colours: [key: NativePalette.Pair(light: 0x111111, dark: 0x222222)]))
                Issue.record("Saving \(key) should throw.")
            } catch {}
        }
        #expect(model.palette == NativePalette())
    }

    @Test func outOfRangeValuesAreRejected() throws {
        let defaults = try suite()
        let model = NativePaletteModel(defaults: defaults)
        do {
            try model.save(NativePalette(colours: ["background": NativePalette.Pair(light: 0x1000000, dark: 0)]))
            Issue.record("Saving an out-of-range value should throw.")
        } catch {}
        #expect(model.palette == NativePalette())
    }

    @Test func malformedStoredValuesRestoreToEmpty() throws {
        let cases: [Data] = [
            Data("not-json".utf8),
            Data(#"{"colours":{"needsYou":{"light":1,"dark":2}}}"#.utf8),
            Data(#"{"colours":{"background":{"light":16777216,"dark":0}}}"#.utf8),
            Data(#"{"colours":{"background":{"light":"red","dark":0}}}"#.utf8),
            Data(#"{"colours":{"background":{"light":1}}}"#.utf8),
            Data(repeating: 0x41, count: 8193),
        ]
        for data in cases {
            let defaults = try suite()
            defaults.set(data, forKey: NativePaletteModel.key)
            #expect(NativePaletteModel(defaults: defaults).palette == NativePalette())
        }
    }

    @Test func tooManyStoredKeysRestoreToEmpty() throws {
        let defaults = try suite()
        var colours: [String: NativePalette.Pair] = [:]
        for key in NativePalette.editable { colours[key] = NativePalette.Pair(light: 1, dark: 2) }
        colours["extra"] = NativePalette.Pair(light: 1, dark: 2)
        defaults.set(try JSONEncoder().encode(NativePalette(colours: colours)), forKey: NativePaletteModel.key)
        #expect(NativePaletteModel(defaults: defaults).palette == NativePalette())
    }

    @Test func resolutionWithoutARegisteredModelKeepsTokenDefaults() {
        NativePaletteBridge.model = nil
        #expect(NativePaletteBridge.pair(for: "card", light: 0xFFFFFF, dark: 0x1A1A1D) == NativePalette.Pair(light: 0xFFFFFF, dark: 0x1A1A1D))
    }

    @Test func actionsKeepAColouredAccentAndTurnBlueWhenTheAccentIsInk() throws {
        let model = NativePaletteModel(defaults: try suite())
        NativePaletteBridge.model = model
        defer { NativePaletteBridge.model = nil }
        let blue = NativePalette.Pair(light: 0x0062CC, dark: 0x0A84FF)

        // The default accent is the body ink, so an action would read as a label.
        #expect(AceDesign.Ink.actionPair == blue)
        model.choose(accent: "orange")
        #expect(AceDesign.Ink.actionPair == NativePalette.Pair(light: 0xB83E0B, dark: 0xF5925A))
        model.choose(accent: "ink")
        #expect(AceDesign.Ink.actionPair == blue)
        // A theme's own near-black ink is still ink.
        model.choose(theme: "paper")
        #expect(AceDesign.Ink.actionPair == blue)
    }

    @Test func actionWordsReadAtFourAndAHalfToOneOnAGroupedRowInEveryThemeAndAccent() throws {
        let model = NativePaletteModel(defaults: try suite())
        NativePaletteBridge.model = model
        defer { NativePaletteBridge.model = nil }
        for theme in AceTheme.themeChoices.map(\.id) {
            model.choose(theme: theme)
            for accent in AceTheme.accentChoices.map(\.id) {
                model.choose(accent: accent)
                let action = AceDesign.Ink.actionPair
                let row = NativePaletteBridge.pair(for: "fill", light: 0xE7E7E7, dark: 0x191919)
                #expect(Self.contrast(action.light, row.light) >= 4.5, "\(theme) · \(accent), light")
                #expect(Self.contrast(action.dark, row.dark) >= 4.5, "\(theme) · \(accent), dark")
            }
        }
    }

    /// WCAG 2's contrast ratio, written out here as the standard states it.
    private static func contrast(_ one: UInt32, _ other: UInt32) -> Double {
        func channel(_ value: UInt32) -> Double {
            let c = Double(value & 255) / 255
            return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        func luminance(_ rgb: UInt32) -> Double {
            0.2126 * channel(rgb >> 16) + 0.7152 * channel(rgb >> 8) + 0.0722 * channel(rgb)
        }
        let lighter = max(luminance(one), luminance(other)), darker = min(luminance(one), luminance(other))
        return (lighter + 0.05) / (darker + 0.05)
    }

    private func suite() throws -> UserDefaults {
        try #require(UserDefaults(suiteName: "ace.tests.\(UUID().uuidString)"))
    }
}
