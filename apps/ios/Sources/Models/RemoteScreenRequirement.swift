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
