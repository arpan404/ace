import Testing
@testable import Ace

struct AddAccountChoiceTests {
    private let browser = AccountWay(id: "login", label: "Sign in with the browser", signIn: nil, cloud: false, next: "")
    private let key = KeyWay(id: "api_key", label: "API key", upstream: nil, next: "")
    private let openai = KeyWay(id: "api_key:openai", label: "OpenAI API key", upstream: "openai", next: "")

    @Test func keyWaysFollowTheSignInWaysAndAreAbsentWhenTheDaemonOffersNone() {
        #expect(AddAccountChoice.all(ways: [browser], keys: [key]).map(\.label) == ["Sign in with the browser", "API key"])
        #expect(AddAccountChoice.all(ways: [browser], keys: []).allSatisfy { $0.keyWay == nil })
        #expect(AddAccountChoice.all(ways: [browser], keys: [key]).first?.keyWay == nil)
    }

    @Test func aKeyRequestNamesItsServiceOnlyWhenTheWayHasOne() {
        let plain = AddAccountChoice.keyRequest(provider: "codex", label: "Work", letters: "WK", way: key, key: "sk-1")
        #expect(plain["type"] as? String == "accounts.screen.key")
        #expect(plain["apiKey"] as? String == "sk-1")
        #expect(plain["upstream"] == nil)
        let routed = AddAccountChoice.keyRequest(provider: "pi", label: "Work", letters: "", way: openai, key: "sk-2")
        #expect(routed["upstream"] as? String == "openai")
    }
}
