import Foundation
import Testing
@testable import Ace

/// Chats' filter keeps the chats whose titles hold every word typed.
@Suite struct ChatsFilterTests {
    @Test func everyWordTypedMustBeInTheTitleInAnyOrder() {
        #expect(ChatsFilter.matches("Plan the relay timeout fix", query: "relay fix"))
        #expect(ChatsFilter.matches("Plan the relay timeout fix", query: "fix relay"))
        #expect(!ChatsFilter.matches("Plan the relay timeout fix", query: "relay docs"))
    }

    @Test func caseAndAccentsDontMatter() {
        #expect(ChatsFilter.matches("Café menu ideas", query: "CAFE"))
        #expect(ChatsFilter.matches("cafe menu", query: "Café"))
    }

    @Test func anEmptyFilterKeepsEveryChat() {
        #expect(ChatsFilter.matches("Anything", query: ""))
        #expect(ChatsFilter.matches("", query: "   "))
    }
}
