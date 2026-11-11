import Foundation

/// An outside app (claude.ai, a bot) waiting for the person to approve its sign-in to a machine
/// (ADR 0117). It reaches the phone two ways: the machine's `outside.state` while ace runs, and
/// the daemon's push, `{ v: 1, hostId, access }`, which carries only these fields. Either way the
/// phone says it the same way, and a tap opens the sign-in sheet for this request.
struct AccessAlert: Decodable, Equatable, Sendable {
    let requestId: String
    let clientName: String
    /// The verified domain; nil when it isn't verified.
    let domain: String?
    let matchCode: String
    /// Milliseconds since 1970.
    let expiresAt: Double

    /// The push payload, decrypted. Nil for anything else, including a thread alert
    /// (`{ v: 1, hostId, notification }`), so each payload is read by the code that knows it.
    static func push(_ data: Data) -> (hostId: String, alert: AccessAlert)? {
        guard let payload = try? JSONDecoder().decode(Payload.self, from: data), payload.v == 1,
              !payload.hostId.isEmpty, payload.access.valid else { return nil }
        return (payload.hostId, payload.access)
    }
    private struct Payload: Decodable { let v: Int; let hostId: String; let access: AccessAlert }
    private var valid: Bool { !requestId.isEmpty && !clientName.isEmpty && !matchCode.isEmpty }

    /// "Claude wants to sign in to studio" over "Code 7KQ2XM · claude.ai": the code first, since
    /// the person compares it with the one on the app's sign-in page.
    func words(machine: String?) -> (title: String, body: String) {
        let place = machine.map { "to \($0)" } ?? "to your computer"
        let from = domain ?? "Unverified app"
        return ("\(clientName) wants to sign in \(place)", "Code \(matchCode) · \(from)")
    }
    /// One notification per request on each machine, so the push and the local alert replace
    /// rather than stack.
    static func identifier(_ requestId: String, hostId: String) -> String { "\(hostId)|access:\(requestId)" }

    /// The keys a tap reads back (`NotificationKeys`); nil when the notification isn't one.
    init?(info: [String: String]) {
        guard let requestId = info[NotificationKeys.accessRequestId], !requestId.isEmpty,
              let clientName = info[NotificationKeys.accessClient], !clientName.isEmpty,
              let expiresAt = info[NotificationKeys.accessExpiresAt].flatMap(Double.init) else { return nil }
        self.init(requestId: requestId, clientName: clientName, domain: nil, matchCode: "", expiresAt: expiresAt)
    }
    init(requestId: String, clientName: String, domain: String?, matchCode: String, expiresAt: Double) {
        self.requestId = requestId; self.clientName = clientName; self.domain = domain
        self.matchCode = matchCode; self.expiresAt = expiresAt
    }
    var info: [String: String] {
        [NotificationKeys.accessRequestId: requestId, NotificationKeys.accessClient: clientName,
         NotificationKeys.accessExpiresAt: String(Int(expiresAt))]
    }
    /// What the bridge needs to open the sheet on it, or say it ended (`outside.open`).
    var openAction: [String: Any] {
        ["type": "outside.open", "requestId": requestId, "clientName": clientName, "expiresAt": expiresAt]
    }
}

extension OutsideClientsModel.Access {
    var alert: AccessAlert {
        AccessAlert(requestId: requestId, clientName: clientName, domain: verified ? domain : nil,
                    matchCode: matchCode, expiresAt: expiresAt)
    }
}
