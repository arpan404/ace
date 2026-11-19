import Foundation
import Testing
@testable import Ace

/// What Settings › Projects shows for the pages it has read and the search typed over them: a
/// search only filters the pages read so far, so the next page stays on offer while it runs.
@Suite struct ProjectListingTests {
    @Test func aSearchWithNoMatchInThePagesReadStillOffersTheNextPage() throws {
        let page = try firstPage(next: "cursor-100")
        #expect(ProjectListing.of(page.projects, next: page.next, loaded: true, reading: false, query: "billing") == .noMatch(more: true))
    }

    @Test func aSearchThatFindsProjectsKeepsTheNextPageOnOffer() throws {
        let page = try firstPage(next: "cursor-100")
        #expect(ProjectListing.of(page.projects, next: page.next, loaded: true, reading: false, query: "web") == .rows(ids: ["p-web"], more: true))
    }

    @Test func aSearchMatchesTheFolderAsWellAsTheName() throws {
        let page = try firstPage(next: nil)
        #expect(ProjectListing.of(page.projects, next: page.next, loaded: true, reading: false, query: "/srv/") == .rows(ids: ["p-api"], more: false))
    }

    @Test func aSearchOverTheLastPageWithNoMatchSaysSo() throws {
        let page = try firstPage(next: nil)
        #expect(ProjectListing.of(page.projects, next: page.next, loaded: true, reading: false, query: "billing") == .noMatch(more: false))
    }

    @Test func onlyAMachineThatAnsweredWithNoProjectsIsEmpty() throws {
        #expect(ProjectListing.of([], next: nil, loaded: true, reading: false, query: "") == .empty)
        #expect(ProjectListing.of([], next: nil, loaded: false, reading: true, query: "") == .reading)
        // Offline before the first read: the list says nothing rather than "No projects".
        #expect(ProjectListing.of([], next: nil, loaded: false, reading: false, query: "") == .unread)
    }

    private func firstPage(next: String?) throws -> (projects: [NativeProject], next: String?) {
        let cursor = next.map { "\"\($0)\"" } ?? "null"
        let json = """
        {"result": {"kind": "projects", "next": \(cursor), "projects": [
          {"id": "p-ace", "name": "ace-next", "path": "/tmp/ace"},
          {"id": "p-web", "name": "web-app", "path": "/tmp/web-app"},
          {"id": "p-api", "name": "api", "path": "/srv/api"},
          {"id": "p-chat", "name": "Chat", "path": "/tmp/chat", "kind": "chat"}
        ]}}
        """
        let reply = try JSONDecoder().decode(ProjectListReply.self, from: Data(json.utf8))
        return (reply.result.projects ?? [], reply.result.next)
    }
}
