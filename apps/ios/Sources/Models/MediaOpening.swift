import Foundation

/// Where published media opens from the transcript. A visualization opens at full size, as the
/// web's visualization tab does: a tab of the iPad's side panel when the panel sits beside the
/// thread, else full screen over it. An image opens in its viewer.
enum MediaOpening: Equatable {
    case panel(title: String)
    case fullScreen
    case viewer

    static func of(_ row: TranscriptRow, panelBeside: Bool) -> MediaOpening {
        guard row.type == "html" else { return .viewer }
        return panelBeside ? .panel(title: tabTitle(row.text)) : .fullScreen
    }

    /// The panel's rules take a title of 1 to 160 UTF-16 units (Zod counts a JavaScript string's
    /// length). Longer titles are cut at the last whole character that fits.
    static func tabTitle(_ text: String) -> String {
        var title = ""
        var units = 0
        for character in text.trimmingCharacters(in: .whitespacesAndNewlines) {
            let size = character.utf16.count
            if units + size > maxTitleUnits { break }
            title.append(character)
            units += size
        }
        return title.isEmpty ? "Visualization" : title
    }

    static let maxTitleUnits = 160
}
