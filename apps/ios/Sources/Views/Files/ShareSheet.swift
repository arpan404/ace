import SwiftUI
import UIKit

/// A file copied to this phone for the share sheet.
struct SharedFile: Identifiable {
    let url: URL
    var id: URL { url }
}

/// The system share sheet for one file; `finished` runs once the person shares or cancels.
struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    var finished: (() -> Void)? = nil
    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        if let finished { controller.completionWithItemsHandler = { _, _, _, _ in finished() } }
        return controller
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
