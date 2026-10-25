import AppKit
import LockedUseUI

@main struct PreviewCommand {
    @MainActor static func main() throws {
        guard CommandLine.arguments.count == 2 else {
            FileHandle.standardError.write(Data("Usage: LockedUsePreview /path/to/preview.png\n".utf8))
            exit(2)
        }
        NSApplication.shared.setActivationPolicy(.accessory)
        try LockedUsePreview.png().write(to: URL(fileURLWithPath: CommandLine.arguments[1]), options: .atomic)
    }
}
