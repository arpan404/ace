import Foundation
import Observation

/// Locked computer use and Use my Chrome on one machine (`bridge/computer-access.ts`), followed
/// while Settings › Computer use shows them. The bridge reads and words the daemon's state; this
/// holds what it last said.
@MainActor @Observable final class ComputerAccessModel {
    struct Locked: Codable, Sendable, Equatable {
        /// On, Off, Needs approval, Install failed, Needs repair.
        let label: String
        /// The tone of the word: done, idle, needs-you or failed.
        let tone: String
        /// The switch reads on (installed, or on its way).
        let on: Bool
        let busy: Bool
        let repair: Bool
        let note: String?
    }
    struct Chrome: Codable, Sendable, Equatable {
        struct Connection: Codable, Sendable, Equatable, Identifiable { let id: String; let title: String; let summary: String }
        let supported: Bool
        let installed: Bool
        let installedFor: [String]
        let extensionPath: String?
        let connections: [Connection]
        let controlled: Bool
    }
    struct State: Codable, Sendable, Equatable {
        let locked: Locked?
        let lockedFailed: Bool
        let chrome: Chrome?
        /// darwin, linux or win32, as the daemon says; nil from an older daemon.
        var platform: String? = nil
        /// Only the machine's owner can change these: the pairing isn't an admin one.
        var ownerOnly: Bool? = nil
        /// The change running now ("locked.install", "chrome.revoke"), if any.
        let busy: String?
        let error: String?
    }
    private(set) var state: State?
    /// Screens showing it now; the bridge follows while there is one.
    @ObservationIgnored fileprivate var followers = 0
    func apply(_ next: State) { if followers > 0, state != next { state = next } }
    func reset() { state = nil }
}

extension ClientModel {
    /// A screen showing locked use or Use my Chrome appeared: the bridge follows them while any
    /// does. `mac`: the machine shares app windows the macOS way, so locked use is offered even
    /// while it is off.
    func followComputerAccess(mac: Bool? = nil) {
        computerAccess.followers += 1
        computerAccessMac(mac)
    }
    /// The machine's way of sharing windows became known.
    func computerAccessMac(_ mac: Bool?) {
        guard computerAccess.followers > 0 else { return }
        var action: [String: Any] = ["kind": "open"]
        if let mac { action["mac"] = mac }
        if let canAdmin { action["admin"] = canAdmin }
        computerAccessAction(action)
    }
    func unfollowComputerAccess() {
        computerAccess.followers = max(0, computerAccess.followers - 1)
        guard computerAccess.followers == 0 else { return }
        computerAccessAction(["kind": "close"])
        computerAccess.reset()
    }
    /// install, remove, repair or recheck.
    func lockedUse(_ op: String) { computerAccessAction(["kind": "locked", "op": op]) }
    /// install, stop or revoke.
    func useMyChrome(_ op: String) { computerAccessAction(["kind": "chrome", "op": op]) }
    /// This phone may change locked use and Use my Chrome: an admin pairing, or one not known
    /// to be otherwise until the daemon refuses it.
    var mayAdminister: Bool { canAdmin != false && computerAccess.state?.ownerOnly != true }
    private func computerAccessAction(_ action: [String: Any]) {
        guard canOperate || action["kind"] as? String == "open" || action["kind"] as? String == "close" else { return }
        self.action(["type": "computer.access", "action": action])
    }
}
