import Foundation
import Testing
@testable import Ace

/// Settings › Spade on the phone: a page as the bridge answers it, and how its reads and
/// changes land, so a refusal never blanks the page and a late read never undoes a change.
@Suite struct SpadeSettingsTests {
    private func answer(_ json: String) throws -> SpadeSettings.Answer {
        try JSONDecoder().decode(SpadeSettings.Answer.self, from: Data(json.utf8))
    }
    private let line = #"{"sentence": "", "ready": true, "canTurnOn": false}"#

    private func models(key: String) throws -> SpadeSettings.Answer {
        try answer("""
        {"ok": true, "line": \(line), "models": {"endpoints": [{"id": "openrouter", "name": "OpenRouter",
          "address": "openrouter.ai", "key": {"words": "\(key)", "set": false, "canSet": true, "canRemove": false},
          "models": ["Kimi K2"], "more": 0}], "presets": [], "keychain": true, "note": "Keys stay here."}}
        """)
    }

    @Test func aRefusedChangeSaysWhyAndKeepsThePageAsItWas() throws {
        var reads = SpadeSettingsReads()
        reads.land(try models(key: "Not set"), ticket: reads.begin())

        let ticket = reads.begin()
        reads.changed(.failed("Couldn't keep the key", "The keychain refused the key."), ticket: ticket)

        #expect(reads.refusal == "Couldn't keep the key. The keychain refused the key.")
        #expect(reads.answer?.models?.endpoints.first?.key.words == "Not set")
    }

    @Test func aReadThatLandsAfterAChangeBeganIsDropped() throws {
        var reads = SpadeSettingsReads()
        let read = reads.begin()
        let change = reads.begin()
        reads.changed(try models(key: "In keychain"), ticket: change)
        // The read began before the change: what it says is older.
        reads.land(try models(key: "Not set"), ticket: read)

        #expect(reads.answer?.models?.endpoints.first?.key.words == "In keychain")
        #expect(reads.refusal == nil)
    }

    @Test func aFailedReadSaysSoOnlyWhileThereIsNoPage() throws {
        var empty = SpadeSettingsReads()
        empty.land(.failed("Couldn't read Spade's settings", "Spade answered 500."), ticket: empty.begin())
        #expect(empty.problem == "Couldn't read Spade's settings. Spade answered 500.")

        var shown = SpadeSettingsReads()
        shown.land(try models(key: "Not set"), ticket: shown.begin())
        shown.land(.failed("Couldn't read Spade's settings", nil), ticket: shown.begin())
        #expect(shown.problem == nil)
        #expect(shown.answer != nil)
    }

    @Test func aPageSpadeCannotAnswerCarriesOnlyItsState() throws {
        let off = try answer(#"{"ok": true, "line": {"sentence": "Spade is off.", "ready": false, "canTurnOn": true}}"#)
        #expect(off.line?.canTurnOn == true)
        #expect(off.models == nil && off.general == nil)
    }
}
