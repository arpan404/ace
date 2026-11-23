import Testing
@testable import Ace

@Suite struct AccountMenuWordsTests {
    @Test func aShortEmailShowsWhole() {
        #expect(AccountMenuWords.email("me@ace.dev") == "me@ace.dev")
    }

    @Test func aLongEmailKeepsItsDomainAndCutsTheNameInTheMiddle() {
        let shown = AccountMenuWords.email("sapanakosansar18@gmail.com")
        #expect(shown == "sapanakosan…@gmail.com")
        #expect(shown.count <= 22)
    }

    @Test func aLongDomainStillFitsOneLine() {
        let shown = AccountMenuWords.email("a@an-extremely-long-company-domain.example")
        #expect(shown.count <= 22)
        #expect(shown.hasSuffix("…"))
    }
}
