import Foundation
import SwiftUI
import Testing
@testable import Ace

/// The Swift reading of the shortcut table must decide exactly what `@ace/ui-core/phone-keymap`
/// decides: the cases and answers are generated from the TS (`PhoneKeymapVectors`).
@Suite @MainActor struct PhoneKeymapTests {
    @Test func spellingsNormaliseAsTheSharedRulesDo() {
        for (input, normalized) in PhoneKeymapVectors.spellings {
            #expect(PhoneKeymap.normalize(input) == normalized, "\(input)")
        }
    }
    @Test func clashesAndReservedKeysMatchTheSharedRules() {
        for check in PhoneKeymapVectors.checks {
            let found: String = switch PhoneKeymap(overrides: check.overrides).problem(check.keys, for: check.id) {
            case nil: ""
            case .invalid: "invalid"
            case .reserved: "reserved"
            case .taken(let id, _): "taken:\(id)"
            }
            #expect(found == check.problem, "\(check.keys) for \(check.id)")
        }
    }
    @Test func shortcutsReadAsTheSharedRulesPrintThem() {
        for (keys, text) in PhoneKeymapVectors.formats { #expect(PhoneKeymap.format(keys) == text) }
    }
    @Test func aRebindingSurvivesStorageAndAResetDropsIt() {
        let rebound = PhoneKeymap(stored: "").binding("newThread", to: "alt+mod+n")
        let reread = PhoneKeymap(stored: rebound.stored)
        #expect(reread.keys("newThread") == "alt+mod+n")
        #expect(reread.shortcut("newThread") == KeyboardShortcut("n", modifiers: [.command, .option]))
        let reset = reread.binding("newThread", to: nil)
        #expect(reset.keys("newThread") == "mod+n")
        #expect(!reset.isChanged("newThread"))
    }
    @Test func aStoredRebindingOfTheSystemsEscIsIgnored() {
        let keymap = PhoneKeymap(stored: #"{"close":"mod+w","send":"nonsense"}"#)
        #expect(keymap.keys("close") == "escape")
        #expect(keymap.keys("send") == "mod+enter")
        #expect(keymap.shortcut("send") == KeyboardShortcut(.return, modifiers: .command))
    }
}
