import Foundation
import UserNotifications

/// Outside apps' sign-ins (ADR 0122) on the coordinator's side. A machine's live `outside.state`
/// posts one alert per new request while ace is in the background, and withdraws it once the
/// machine stops listing it (answered, expired or cancelled). A tap, on that alert or on the
/// daemon's push, opens the sign-in sheet for that request on its machine, or says it ended.
extension NotificationCoordinator {
    /// A live state from one machine: what it lists waiting for approval now.
    func accessState(_ access: [OutsideClientsModel.Access], hostId: String) {
        let pending = Set(access.map(\.requestId))
        let known = accessSeen[hostId, default: []]
        // Gone from the machine: whatever names it is out of date. A push for it shares the id.
        let gone = known.subtracting(pending)
        if !gone.isEmpty { desk.withdraw(gone.sorted().map { AccessAlert.identifier($0, hostId: hostId) }) }
        for request in access where !known.contains(request.requestId) {
            // In the foreground the sheet opens by itself.
            guard !foreground, delivering(hostId) else { continue }
            desk.post(.access(request.alert, hostId: hostId, machine: machineName(hostId)))
        }
        accessSeen[hostId] = pending
    }
    /// A tapped sign-in alert. The machine's bridge opens the sheet on it once the machine lists
    /// it; a phone that hasn't reached the machine yet asks as soon as it connects.
    func openAccess(_ alert: AccessAlert, hostId: String?) {
        guard let model = client(hostId) else {
            pendingAccess = (alert, hostId)
            return
        }
        if model.connection != "ready" { model.retry() }
        if !model.action(alert.openAction) { pendingAccess = (alert, hostId) }
    }
    /// The machine connected: a tap that waited for it goes now.
    func connectedForAccess(_ model: ClientModel, hostId: String) {
        guard let (alert, wanted) = pendingAccess, wanted == nil || wanted == hostId else { return }
        if model.action(alert.openAction) { pendingAccess = nil }
    }
    /// No banner over the sign-in sheet that is already showing the same request.
    func accessPresentation(_ requestId: String, hostId: String?) -> UNNotificationPresentationOptions {
        if let hostId, MachinesModel.turnedOff(in: defaults).contains(hostId) { return [] }
        if foreground, client(hostId)?.outside.access.contains(where: { $0.requestId == requestId }) == true { return [] }
        return [.banner, .list, .sound]
    }
}

extension OutsideClientsModel.Access {
    var alert: AccessAlert {
        AccessAlert(requestId: requestId, clientName: clientName, domain: verified ? domain : nil,
                    matchCode: matchCode, expiresAt: expiresAt)
    }
}
