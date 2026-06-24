import SwiftUI

enum AppIcon: String {
    case add = "plus"
    case addProject = "folder.badge.plus"
    case assistant = "sparkles"
    case commandPalette = "command"
    case collapseSidebar = "sidebar.leading"
    case connected = "checkmark.circle"
    case disconnected = "exclamationmark.circle"
    case expand = "chevron.right"
    case expanded = "chevron.down"
    case folder = "folder"
    case keyboard = "keyboard"
    case newThread = "square.and.pencil"
    case pin = "pin"
    case pinned = "pin.fill"
    case refresh = "arrow.clockwise"
    case send = "arrow.up.circle.fill"
    case user = "person.crop.circle"

    var image: Image {
        Image(systemName: rawValue)
    }
}
