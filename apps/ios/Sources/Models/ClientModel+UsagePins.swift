import Foundation

extension ClientModel {
    /// The accounts this phone's Usage glyph draws for this machine, in order.
    var usagePins: [String] { hostId.map { UsagePins.read($0) } ?? [] }

    /// Saves the choice and tells the runtime, which redraws the glyph. Empty is the default.
    func setUsagePins(_ ids: [String]) {
        guard let hostId else { return }
        UsagePins.write(ids, hostId)
        sendUsagePins()
    }

    func sendUsagePins() {
        inboxRequest(["kind": "usagePins", "ids": usagePins])
    }

    /// At every runtime start: the bridge holds the choice only while it runs. A new runtime
    /// starts on the default, so with nothing chosen there is nothing to tell it.
    func resumeUsagePins() {
        if !usagePins.isEmpty { sendUsagePins() }
    }
}
