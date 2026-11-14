import Testing
@testable import Ace

/// A subagent ace delegated to another machine opens on that machine when the phone reaches it,
/// and otherwise says which machine has it and why it can't open, as the web's
/// delegated-elsewhere view does. Nothing falls back to another machine.
@Suite struct DelegatedElsewhereTests {
    @Test func aChildOnAConnectedPairedMachineOpensThere() {
        #expect(DelegatedElsewhere.reach(host: "studio", name: "Studio", connection: "ready") == .open(machineId: "studio"))
    }

    @Test func aChildOnAMachineStillConnectingSaysItIsConnecting() {
        #expect(DelegatedElsewhere.reach(host: "studio", name: "Studio", connection: "connecting") == .away("Connecting to Studio…"))
        #expect(DelegatedElsewhere.reach(host: "studio", name: "Studio", connection: "starting") == .away("Connecting to Studio…"))
    }

    @Test func aChildOnAPairedMachineThatIsOfflineNamesTheMachine() {
        #expect(DelegatedElsewhere.reach(host: "studio", name: "Studio", connection: "fatal")
            == .away("Studio isn't connected. Open this subagent again once it's back."))
    }

    @Test func aChildOnAMachineThisPhoneIsNotPairedWithSaysSo() {
        #expect(DelegatedElsewhere.reach(host: "studio", name: "Studio", connection: nil)
            == .away("This phone isn't paired with Studio, where this subagent runs."))
    }
}
