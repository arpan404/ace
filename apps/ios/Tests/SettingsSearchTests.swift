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

    @Test func aMachinesToolPagesAreFoundBeforeItsIndexIsRead() throws {
        let items = SettingsSearch.machineSearchItems(nil, machine: "studio", fleet: false, spade: false)
        #expect(SettingsSearch.matches(items, query: "computer").map(\.title) == ["Computer use"])
        let computer = try #require(SettingsSearch.matches(items, query: "computer").first)
        #expect(computer.target == .phone(.tool(.computer, machine: "studio")))
        #expect(SettingsSearch.matches(items, query: "source control").first?.target == .phone(.tool(.sourceControl, machine: "studio")))
        #expect(SettingsSearch.matches(items, query: "quota").first?.title == "Usage")
        // Spade is offered only where the machine shows it.
        #expect(SettingsSearch.matches(items, query: "spade").isEmpty)
        let spade = SettingsSearch.machineSearchItems(nil, machine: "studio", fleet: false, spade: true)
        #expect(SettingsSearch.matches(spade, query: "spade").map(\.title) == ["Spade"])
    }

    @Test func aToolTheIndexListsAsAPageShowsOnce() {
        let items = SettingsSearch.machineSearchItems(entries, machine: "studio", fleet: false, spade: false)
        let agents = SettingsSearch.matches(items, query: "agents").filter { $0.place == nil }
        #expect(agents.map(\.target) == [.machine(machine: "studio", page: "agents", pageTitle: "Agents", row: "")])
        // The tool's own words still find that page.
        #expect(SettingsSearch.matches(items, query: "subagents").first?.target
            == .machine(machine: "studio", page: "agents", pageTitle: "Agents", row: ""))
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

    /// With no machine answering, Search still finds this phone's pages, by a setting on them too,
    /// and each opens its page with no machine at all.
    @Test func searchFindsThePhonesOwnPagesWithNoMachine() throws {
        let items = SettingsSearch.phoneItems(notifications: true, lock: true)
        let dark = SettingsSearch.phoneCommands(items, query: "dark mode")
        #expect(dark.map(\.label) == ["Appearance"])
        let appearance = try #require(dark.first)
        #expect(appearance.detail == "Settings")
        #expect(PlaceSheet.of(command: appearance.id, machine: nil, serial: 1)?.start == [.appearance])
        // Two settings on one page list the page once.
        #expect(SettingsSearch.phoneCommands(items, query: "face id").map(\.label) == ["App lock"])
        let every = SettingsSearch.phoneCommands(items, query: "e")
        #expect(every.filter { $0.id != "settings" }.allSatisfy { PlaceSheet.of(command: $0.id, machine: nil, serial: 1)?.start.isEmpty == false })
        #expect(SettingsSearch.phoneCommands(SettingsSearch.phoneItems(notifications: false, lock: false), query: "face id").isEmpty)
    }

    /// Settings itself opens with no machine, so it is found offline by the words the palette
    /// finds it by, ahead of the pages inside it.
    @Test func searchFindsSettingsItselfWithNoMachine() throws {
        let items = SettingsSearch.phoneItems(notifications: true, lock: true)
        let settings = try #require(SettingsSearch.phoneCommands(items, query: "settings").first)
        #expect(settings.label == "Settings")
        #expect(PlaceSheet.of(command: settings.id, machine: nil, serial: 1)?.root == .settings)
        #expect(SettingsSearch.phoneCommands(items, query: "preferences").map(\.label) == ["Settings"])
        #expect(!SettingsSearch.phoneCommands(items, query: "dark mode").contains { $0.label == "Settings" })
    }
}
