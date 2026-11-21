import Foundation

/// The one paired machine and device a runtime's sockets prove the person's standing for.
struct StandingSigner: Sendable, Equatable { let hostId: String; let deviceId: String }

/// One paired machine's socket proving the person's standing (ADR 0190 §7), done natively so
/// the script can't choose what is signed: the challenge comes from the welcome that arrived on
/// this very socket, the binding from this socket's own transport, the device from its target.
/// The proof goes out on the same socket, and the daemon's answer to it is read here and never
/// reaches the script, which hears only the verdict. Pure: `PinnedSocket` drives it.
struct PairedStandingProof: Sendable {
    enum Step: Equatable, Sendable {
        /// The daemon asks for no proof (an older one, or a welcome without a challenge).
        case notAsked
        /// The phone can't prove here: no key for this machine, or a challenge that isn't canonical.
        case missing
        /// Send this `device.standing` message on the socket the welcome came by.
        case send(String)
    }
    let signer: StandingSigner
    let keys: StandingKeys
    /// The socket's channel binding: nil on a pinned direct socket, which has no channel of its own.
    let binding: String?
    /// This socket's proof's request id, so only the answer to it is taken as the verdict.
    let requestId: String

    private struct Welcome: Decodable { let type: String; let standingNonce: String?; let standingHost: String? }

    /// What to do with the daemon's welcome on this socket.
    func step(forWelcome text: String) -> Step {
        guard let welcome = try? JSONDecoder().decode(Welcome.self, from: Data(text.utf8)), welcome.type == "welcome",
              let host = welcome.standingHost, let nonce = welcome.standingNonce else { return .notAsked }
        guard let proof = try? keys.proof(host: host, nonce: nonce, binding: binding, deviceId: signer.deviceId, hostId: signer.hostId),
              let data = try? JSONSerialization.data(withJSONObject: ["type": "device.standing", "requestId": requestId, "proof": proof],
                                                     options: [.sortedKeys, .withoutEscapingSlashes]) else { return .missing }
        return .send(String(decoding: data, as: UTF8.self))
    }

    /// The daemon's verdict when `text` answers this socket's proof; nil for every other message.
    func verdict(_ text: String) -> PairedStanding? {
        guard text.hasPrefix(#"{"type":"account.standing.result""#),
              let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              object["requestId"] as? String == requestId else { return nil }
        let result = object["result"] as? [String: Any]
        // `member`: a member's standing on an org host (ADR 0206), never the person's.
        return result?["ok"] as? Bool == true && result?["member"] == nil ? .proven : .missing
    }
}
