import Testing
@testable import Ace

@Suite struct SearchScopeTests {
    private let mixed = [(hostId: "desk", connection: "ready"), (hostId: "laptop", connection: "reconnecting")]

    @Test func aProjectOnADisconnectedMachineIsOfflineWhileAnotherMachineIsReady() {
        #expect(SearchScope(project: "laptop/ws-1").offline(mixed))
    }
    @Test func aProjectOnAReadyMachineIsSearchable() {
        #expect(!SearchScope(project: "desk/ws-1").offline(mixed))
    }
    @Test func everyProjectIsSearchableWhileAnyMachineIsReady() {
        #expect(!SearchScope().offline(mixed))
    }
    @Test func everyProjectIsOfflineWhenNoMachineIsReady() {
        #expect(SearchScope().offline([(hostId: "desk", connection: "connecting"), (hostId: "laptop", connection: "reconnecting")]))
    }
    @Test func aProjectOnAMachineNoLongerPairedCannotBeSearched() {
        #expect(SearchScope(project: "gone/ws-1").offline(mixed))
    }
    @Test func withNoMachinePairedSearchIsNotOffline() {
        #expect(!SearchScope().offline([]))
    }
}
