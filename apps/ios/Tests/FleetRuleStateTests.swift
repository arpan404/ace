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

@Suite struct FleetRuleRowTests {
    private let names = ["studio": "Studio", "laptop": "Laptop"]

    @Test func aMachineThatTimedOutShowsNoValueAndNamesTheMachine() {
        let answers = FleetRuleState.answers(from: [("remote.enabled", "studio", .bool(true)), ("remote.enabled", "laptop", nil)])
        let shown = FleetRuleState.of(key: "remote.enabled", hosts: ["studio", "laptop"], answers: answers["remote.enabled"] ?? [:])
            .display { names[$0] ?? $0 }
        #expect(shown.value == nil)
        #expect(shown.caption == "Couldn't read Laptop. Pull to refresh.")
    }
    @Test func machinesThatDisagreeShowNoValueAndSaySo() {
        let answers = FleetRuleState.answers(from: [("remote.agentAccess", "studio", .string("off")), ("remote.agentAccess", "laptop", .string("operate"))])
        let shown = FleetRuleState.of(key: "remote.agentAccess", hosts: ["studio", "laptop"], answers: answers["remote.agentAccess"] ?? [:])
            .display { names[$0] ?? $0 }
        #expect(shown.value == nil)
        #expect(shown.caption == "Differs between machines")
    }
    @Test func machinesThatAgreeShowTheirValueWithNoCaption() {
        let answers = FleetRuleState.answers(from: [("remote.enabled", "studio", .bool(false)), ("remote.enabled", "laptop", .bool(false))])
        let shown = FleetRuleState.of(key: "remote.enabled", hosts: ["studio", "laptop"], answers: answers["remote.enabled"] ?? [:])
            .display { names[$0] ?? $0 }
        #expect(shown.value == .bool(false))
        #expect(shown.caption == nil)
    }
}
