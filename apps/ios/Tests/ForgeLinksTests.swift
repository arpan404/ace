import Foundation
import Testing
@testable import Ace

/// Taps in pull request and issue text open the pages GitHub would, and nothing else.
@Suite struct ForgeLinksTests {
    private let links = ForgeLinks(host: "github.com", owner: "acme", name: "ace")
    private func url(_ text: String) -> URL { URL(string: text) ?? URL(fileURLWithPath: "/") }

    @Test func webLinksOpenAndRootPathsOpenOnTheForge() {
        #expect(links.link(url("https://example.com/notes")) == url("https://example.com/notes"))
        #expect(links.link(url("mailto:team@example.com")) == url("mailto:team@example.com"))
        #expect(links.link(url("/acme/ace/blob/main/README.md")) == url("https://github.com/acme/ace/blob/main/README.md"))
    }

    @Test func scriptsAndAppSchemesNeverOpen() {
        #expect(links.link(url("javascript:alert(1)")) == nil)
        #expect(links.link(url("file:///etc/passwd")) == nil)
        #expect(links.link(url("//evil.example/path")) == nil)
    }

    @Test func mentionsOpenThePersonOrTheTeam() {
        #expect(links.reference(kind: "mention", target: "octocat") == url("https://github.com/octocat"))
        #expect(links.reference(kind: "mention", target: "acme/core") == url("https://github.com/orgs/acme/teams/core"))
    }

    @Test func issueReferencesOpenInThisRepositoryOrTheOneNamed() {
        #expect(links.reference(kind: "issue", target: "#245") == url("https://github.com/acme/ace/issues/245"))
        #expect(links.reference(kind: "issue", target: "rust-lang/rust#9") == url("https://github.com/rust-lang/rust/issues/9"))
        #expect(links.reference(kind: "issue", target: "#0") == nil)
    }

    @Test func commitsOpenTheirPage() {
        #expect(links.reference(kind: "commit", target: "a1b2c3d4e5") == url("https://github.com/acme/ace/commit/a1b2c3d4e5"))
        #expect(links.reference(kind: "commit", target: "acme/markit@0c707fc") == url("https://github.com/acme/markit/commit/0c707fc"))
        #expect(links.reference(kind: "commit", target: "not-a-sha") == nil)
    }

    @Test func aTargetCarryingAnotherAddressIsRefused() {
        #expect(links.reference(kind: "mention", target: "octocat?x=https://evil.example") == nil)
        #expect(links.reference(kind: "footnote", target: "1") == nil)
    }

    @Test func imagesLoadOnlyFromWebAddresses() {
        #expect(links.image("https://github.com/user-attachments/assets/1") == "https://github.com/user-attachments/assets/1")
        #expect(links.image("/acme/ace/raw/main/shot.png") == "https://github.com/acme/ace/raw/main/shot.png")
        #expect(links.image("data:image/png;base64,AAAA") == nil)
        #expect(links.image("file:///private/var/shot.png") == nil)
    }
}
