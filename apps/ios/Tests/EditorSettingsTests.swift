import Foundation
import Testing
@testable import Ace

@Suite struct EditorSettingsTests {
    @Test func autoSaveWaitsForTypingToRestAndTheLastKeystrokeWins() {
        let autoSave = EditorAutoSave(mode: .pause, delay: 1000)
        #expect(autoSave.typed(at: 0) == 1000)
        #expect(autoSave.typed(at: 300) == 1300)
    }

    @Test func autoSaveOffArmsNothing() {
        #expect(EditorAutoSave(mode: .off, delay: 1000).typed(at: 0) == nil)
    }

    @Test func autoSaveStopsUntilThePersonSavesByHand() {
        var autoSave = EditorAutoSave(mode: .pause, delay: 1000)
        autoSave.failed()
        #expect(autoSave.typed(at: 0) == nil)
        autoSave.savedByHand()
        #expect(autoSave.typed(at: 0) == 1000)
    }

    @Test func thePauseTheEditorWaitsIsTheOneSettingsChose() {
        let preferences = EditorPreferences(autoSave: .pause, autoSaveDelay: 2000)
        let autoSave = EditorAutoSave(mode: preferences.autoSave, delay: preferences.autoSaveDelay)
        #expect(autoSave.typed(at: 0) == 2000)
    }

    @Test func aTypedTabWritesTheChosenIndentStep() {
        #expect(EditorPreferences(tabSize: 4, insertSpaces: true).indent == "    ")
        #expect(EditorPreferences(tabSize: 8, insertSpaces: true).indent == "        ")
        #expect(EditorPreferences(tabSize: 4, insertSpaces: false).indent == "\t")
    }

    @Test func aRowIsNeverTighterThanItsGlyphsButFollowsTheLineHeight() {
        let single = EditorPreferences(lineSpacing: 1)
        #expect(single.lineHeight(forFontSize: 40) >= 42)
        let tight = EditorPreferences(lineSpacing: 1.45).lineHeight(forFontSize: 20)
        let normal = EditorPreferences(lineSpacing: 1.7).lineHeight(forFontSize: 20)
        let relaxed = EditorPreferences(lineSpacing: 2).lineHeight(forFontSize: 20)
        #expect(tight < normal && normal < relaxed)
    }

    @Test func aStoredValueThisBuildCannotDrawFallsBackOrClamps() {
        let defaults = UserDefaults(suiteName: "ace.editor.tests.\(UUID().uuidString)") ?? .standard
        defaults.set("sometimes", forKey: EditorPreferences.autoSaveKey)
        defaults.set(400, forKey: EditorPreferences.fontSizeKey)
        let preferences = EditorPreferences(defaults: defaults)
        #expect(preferences.autoSave == .off)
        #expect(preferences.fontSize == 40)
        #expect(preferences.tabSize == 2)
        #expect(preferences.insertSpaces)
    }
}
