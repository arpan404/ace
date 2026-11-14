import Foundation

struct RemoteScreenRequirement: Decodable, Identifiable {
    let kind: String
    let state: String
    let title: String
    let message: String
    let action: String?
    let permission: String?
    var id: String { kind }
    var requestPermission: String? {
        guard !["ready", "granted", "n/a", "not-applicable"].contains(state),
              let permission,
              ["screenRecording", "accessibility"].contains(permission) else { return nil }
        return permission
    }
}

/// One permission ace's screen helper needs on the machine, as web's Computer use › Permissions
/// shows it: granted or not, and the action that asks the machine for it when it isn't.
struct ScreenPermissionRow: Identifiable, Equatable {
    let id: String
    let title: String
    let detail: String
    let status: String
    let ready: Bool
    /// The permission `permissions.request` asks the machine for; nil when there's nothing to ask.
    let permission: String?
    let action: String?

    /// Every permission, granted ones too, so the person can review them.
    static func rows(_ permissions: RemoteScreenPermissions) -> [ScreenPermissionRow] {
        if let requirements = permissions.requirements {
            return requirements.map { requirement in
                let (status, ready) = requirementStatus(requirement.state)
                let permission = requirement.requestPermission
                return ScreenPermissionRow(id: requirement.kind, title: requirement.title, detail: requirement.message,
                                           status: status, ready: ready, permission: permission,
                                           action: permission == nil ? nil : requirement.action ?? "Grant access")
            }
        }
        return [
            legacy("screenRecording", title: "Screen Recording", detail: "See app windows.", granted: permissions.screenRecording),
            legacy("accessibility", title: "Accessibility", detail: "Control apps.", granted: permissions.accessibility),
        ]
    }

    private static func legacy(_ key: String, title: String, detail: String, granted: Bool) -> ScreenPermissionRow {
        ScreenPermissionRow(id: key, title: title, detail: detail, status: granted ? "Granted" : "Not granted", ready: granted,
                            permission: granted ? nil : key, action: granted ? nil : "Grant access")
    }

    /// `@ace/ui-core`'s `requirementStatus`, in the same words.
    private static func requirementStatus(_ state: String) -> (String, Bool) {
        switch state {
        case "ready", "granted", "n/a", "not-applicable": ("Ready", true)
        case "prompt": ("Needs your approval", false)
        case "blocked", "denied": ("Needs attention", false)
        default: ("Not checked", false)
        }
    }
}
