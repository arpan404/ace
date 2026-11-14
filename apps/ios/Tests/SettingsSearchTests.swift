import Foundation
import Testing
@testable import Ace

/// Settings' search finds pages and single settings on this phone and on each machine, by name
/// and the words people use for them, and says where each one sits.
@Suite struct SettingsSearchTests {
    private let entries = [
        SettingsIndexEntry(page: "remote", pageTitle: "Remote access", section: nil, row: "remote.relay", title: "Relay"),
        SettingsIndexEntry(page: "remote", pageTitle: "Remote access", section: nil, row: "remote.relayUrl", title: "Your own relay"),
        SettingsIndexEntry(page: "agents", pageTitle: "Agents", section: "Roles", row: "roles.review", title: "Review"),
        SettingsIndexEntry(page: "fleet", pageTitle: "Fleet", section: nil, row: "remote.agentTransfers", title: "Agents can move projects"),
    ]

    @Test func everyWordMustMatchAndTitlesStartingWithTheQueryComeFirst() {
        let items = SettingsSearch.machineItems(entries, machine: "studio", fleet: false)
        #expect(SettingsSearch.matches(items, query: "relay").map(\.title) == ["Relay", "Your own relay"])
        #expect(SettingsSearch.matches(items, query: "own relay").map(\.title) == ["Your own relay"])
        #expect(SettingsSearch.matches(items, query: "  ").isEmpty)
        #expect(SettingsSearch.matches(items, query: "relay nowhere").isEmpty)
    }

    @Test func aMachineSettingSaysItsPageAndSectionAndOpensThatRow() throws {
        let items = SettingsSearch.machineItems(entries, machine: "studio", fleet: false)
        let review = try #require(SettingsSearch.matches(items, query: "review").first)
        #expect(review.place == "Agents · Roles")
        #expect(review.target == .machine(machine: "studio", page: "agents", pageTitle: "Agents", row: "roles.review"))
        // A page name finds the page itself, opened at its top.
        let page = try #require(SettingsSearch.matches(items, query: "remote access").first)
        #expect(page.title == "Remote access")
        #expect(page.target == .machine(machine: "studio", page: "remote", pageTitle: "Remote access", row: ""))
    }

    @Test func fleetSettingsShowOnlyWhileTheMachineLinksToAnother() {
        let hidden = SettingsSearch.machineItems(entries, machine: "studio", fleet: false)
        #expect(SettingsSearch.matches(hidden, query: "move projects").isEmpty)
        let shown = SettingsSearch.machineItems(entries, machine: "studio", fleet: true)
        #expect(SettingsSearch.matches(shown, query: "move projects").map(\.title) == ["Agents can move projects"])
    }

    @Test func phoneSettingsAreFoundByTheWordsPeopleUse() {
        let items = SettingsSearch.phoneItems(notifications: true, lock: true)
        #expect(SettingsSearch.matches(items, query: "dark mode").first?.target == .phone(.appearance))
        #expect(SettingsSearch.matches(items, query: "face id").first?.target == .phone(.lock))
        #expect(SettingsSearch.matches(items, query: "shortcuts").first?.target == .phone(.keyboard))
        #expect(SettingsSearch.matches(items, query: "quiet").first?.place == "Notifications")
    }

    @Test func pagesThePhoneDoesntHaveAreNotOffered() {
        let items = SettingsSearch.phoneItems(notifications: false, lock: false)
        #expect(SettingsSearch.matches(items, query: "face id").isEmpty)
        #expect(SettingsSearch.matches(items, query: "notifications").isEmpty)
    }
}
