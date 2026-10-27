import Testing
@testable import Ace

@Suite struct FleetRuleStateTests {
    private let hosts = ["studio", "laptop"]

    @Test func aMachineThatCouldNotBeReadNeverCountsAsAgreeing() {
        let state = FleetRuleState.of(key: "remote.enabled", hosts: hosts, answers: ["studio": .value(.bool(true)), "laptop": .failed])
        #expect(state == .incomplete(["laptop"]))
    }
    @Test func aMachineThatHasNotAnsweredYetLeavesTheRuleIncomplete() {
        let state = FleetRuleState.of(key: "remote.enabled", hosts: hosts, answers: ["studio": .value(.bool(true))])
        #expect(state == .incomplete(["laptop"]))
    }
    @Test func machinesThatAnsweredDifferentlyDifferEvenWithOneUnread() {
        let state = FleetRuleState.of(key: "remote.agentAccess", hosts: hosts + ["mini"],
                                      answers: ["studio": .value(.string("off")), "laptop": .value(.string("read")), "mini": .failed])
        #expect(state == .differs)
    }
    @Test func everyMachineAnsweringTheSameAgrees() {
        let state = FleetRuleState.of(key: "remote.transport", hosts: hosts, answers: ["studio": .value(.string("local")), "laptop": .value(.string("lan"))])
        #expect(state == .agreed(.string("lan")))
    }
}
