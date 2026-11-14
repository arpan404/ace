import Foundation
import Testing
@testable import Ace

/// Choosing a palette command on the home screen does what it names: switches machine, opens a
/// place, a settings page by name, or one of the open thread's places.
@Suite struct HomeCommandTests {
    @Test func machineCommandsSwitchToThatMachineOrBackToEveryMachine() {
        #expect(HomeCommand(id: "machine:studio") == .machine("studio"))
        #expect(HomeCommand(id: "machine:") == .machine(""))
    }

    @Test func historyArchivedAndTheForgeListsOpenAsPlaces() {
        #expect(HomeCommand(id: "history") == .place(.history))
        #expect(HomeCommand(id: "archived") == .place(.archived))
        #expect(HomeCommand(id: "pulls") == .place(.pulls))
        #expect(HomeCommand(id: "new-thread") == .newThread)
        #expect(HomeCommand(id: "new-chat") == .newChat)
    }

    @Test func theOpenThreadsCommandsOpenItsPlacesAndAnUnknownOneFallsToSettings() {
        #expect(HomeCommand(id: "thread:changes") == .thread(.changes))
        #expect(HomeCommand(id: "thread:nowhere") == .settings("thread:nowhere"))
        #expect(HomeCommand(id: "settings:keyboard") == .settings("settings:keyboard"))
    }

    @Test func aSettingsPageByNameOpensOnThatPageInsideSettings() {
        let pages: [(String, SettingsRoute)] = [
            ("settings:notifications", .notifications), ("settings:keyboard", .keyboard), ("settings:lock", .lock),
            ("settings:account", .account), ("settings:cache", .cache), ("settings:appearance", .appearance),
        ]
        for (id, route) in pages {
            let sheet = PlaceSheet.of(command: id, machine: "studio", serial: 1)
            #expect(sheet?.root == .settings)
            #expect(sheet?.start == [route], "\(id)")
        }
        #expect(PlaceSheet.of(command: "tool:usage", machine: "studio", serial: 1)?.start == [.tool(.usage, machine: "studio")])
        #expect(PlaceSheet.of(command: "tool:usage", machine: nil, serial: 1) == nil)
    }

    @Test func historyAndArchivedPlacesOpenTheirPagesInSettingsSheet() {
        #expect(PlaceSheet.of(SearchPlace.history, machine: "studio", id: 1)?.root == .history)
        #expect(PlaceSheet.of(SearchPlace.archived, machine: "studio", id: 1)?.root == .archive)
    }
}
