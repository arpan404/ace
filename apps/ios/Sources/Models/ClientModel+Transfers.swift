import Foundation

/// Continue on… and Open on… (ADR 0101): the bridge walks the sheet and starts the transfer;
/// these send what the person chose.
extension ClientModel {
    @discardableResult func transfer(_ value: [String: Any]) -> Bool { action(["type": "transfers", "action": value]) }
    /// Open the sheet for the open thread.
    func continueOn(threadId: String, title: String) {
        transfer(["kind": "open", "subject": ["kind": "thread", "threadId": threadId, "title": title]])
    }
    /// Open the sheet for a project of this machine.
    func openOn(workspaceId: String, name: String) {
        transfer(["kind": "open", "subject": ["kind": "project", "workspaceId": workspaceId, "name": name]])
    }
    /// Cancel, Try again or Dismiss on a transfer's line.
    func transferLine(_ transferId: String, act: String) {
        transfer(["kind": "line", "transferId": transferId, "act": act])
    }
    /// Read the linked machines again (the sheet or Settings › Fleet is showing).
    func readTransferMachines() { transfer(["kind": "machines"]) }
}
