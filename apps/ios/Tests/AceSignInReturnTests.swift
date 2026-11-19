import Foundation
import Testing
@testable import Ace

struct AceSignInReturnTests {
    @Test func theBrowserReturningFromSignInCarriesOnlyHowItEnded() {
        #expect(AceSignInReturn.status(URL(string: "ace://account/signed-in?status=signed-in")!) == "signed-in")
        #expect(AceSignInReturn.status(URL(string: "ace://account/signed-in?status=cancelled")!) == "cancelled")
        for text in ["ace://account/signed-in", "ace://account/signed-in?status=token",
                     "ace://account/signed-in?status=signed-in&code=x", "ace://thread/t-1?status=signed-in"] {
            #expect(AceSignInReturn.status(URL(string: text)!) == nil)
        }
        #expect(AceSignInReturn.message("signed-in") == nil)
        #expect(AceSignInReturn.message("cancelled") == "Sign-in was cancelled.")
    }

    @Test func signInReturnsAreNeverQueuedAsLinksToOpen() {
        var links = PendingLinks()
        links.add(URL(string: "ace://account/signed-in?status=signed-in")!)
        links.add(URL(string: "ACE://Account/other")!)
        let thread = URL(string: "ace://thread/t-1")!
        links.add(thread)
        #expect(links.waiting == [thread])
    }
}
