import Foundation
import Testing
@testable import Ace

/// The line above a brief another thread sent: which title it reads and where a tap goes.
@Suite struct SentLineTests {
    private func sent(threadId: String = "starter", host: String = "", line: String = "Sent by Old title") -> SentLine {
        SentLine(provider: "claude", threadId: threadId, host: host, line: line)
    }

    @Test func aSenderOnThisMachineReadsByItsCurrentTitleAndOpensHere() {
        #expect(sent().shown(current: "Redesign Sidebar") == "Sent by Redesign Sidebar")
        #expect(sent().target == .thread("starter"))
    }

    @Test func aSenderTheListDoesNotKnowKeepsTheBridgesLine() {
        #expect(sent().shown(current: nil) == "Sent by Old title")
        #expect(sent().shown(current: "  ") == "Sent by Old title")
    }

    @Test func aSenderOnAPairedMachineKeepsItsMachineAndOpensByItsLink() {
        let remote = sent(threadId: "far", host: "host-linux", line: "Sent by Upload fixes · Linux box")
        // A thread with the same id on this machine is not the sender.
        #expect(remote.shown(current: "Local thread") == "Sent by Upload fixes · Linux box")
        #expect(remote.target == .link(AceLink.thread("far", machine: "host-linux")))
    }

    @Test func anUnknownSenderOpensNothing() {
        let unknown = sent(threadId: "", line: "Sent from another thread")
        #expect(unknown.shown(current: "Anything") == "Sent from another thread")
        #expect(unknown.target == nil)
    }
}
