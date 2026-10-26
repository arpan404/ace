import Foundation

/// Chrome-family browsers that build their accessibility tree only for clients that ask
/// through `AXManualAccessibility`.
private let cuChromiumBundlePrefixes = [
    "com.google.chrome", "org.chromium.", "com.microsoft.edgemac", "com.brave.browser", "com.vivaldi.vivaldi",
    "com.operasoftware.opera", "company.thebrowser.", "com.naver.whale", "ru.yandex.desktop.yandex-browser",
    "com.sigmaos.sigmaos", "net.imput.helium", "ai.perplexity.comet",
]

/// Whether an app embeds Chromium (Electron, CEF, or a Chrome-family browser), judged from
/// its bundle id and the names of its bundled frameworks.
func cuIsChromiumFamily(bundleId: String?, frameworks: [String]) -> Bool {
    let id = bundleId?.lowercased() ?? ""
    if cuChromiumBundlePrefixes.contains(where: { id.hasPrefix($0) }) { return true }
    return frameworks.contains { name in
        name == "Electron Framework.framework" || name == "Chromium Embedded Framework.framework"
    }
}

/// Whether a Chromium window's walk came back before its web content. The window's own
/// buttons and wrapper groups are there at once; the web area follows a moment later.
func cuChromiumTreePending(_ nodes: [CUNode]) -> Bool {
    !nodes.contains { $0.axRole == "AXWebArea" }
}

/// Framework folder names inside an app bundle; empty when unreadable.
func cuBundleFrameworks(_ bundle: URL?) -> [String] {
    guard let bundle else { return [] }
    let folder = bundle.appendingPathComponent("Contents/Frameworks").path
    return (try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? []
}
