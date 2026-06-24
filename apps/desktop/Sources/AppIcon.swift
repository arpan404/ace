import SwiftUI

enum AppIcon: String {
    case add = "plus"
    case addProject = "folder.badge.plus"
    case collapseSidebar = "sidebar.leading"
    case connected = "checkmark.circle"
    case disconnected = "exclamationmark.circle"
    case expand = "chevron.right"
    case expanded = "chevron.down"
    case folder = "folder"
    case newThread = "square.and.pencil"
    case pin = "pin"
    case pinned = "pin.fill"
    case send = "arrow.up.circle.fill"

    var image: Image {
        Image(systemName: rawValue)
    }
}
