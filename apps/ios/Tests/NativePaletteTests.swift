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

    private func suite() throws -> UserDefaults {
        try #require(UserDefaults(suiteName: "ace.tests.\(UUID().uuidString)"))
    }
}
