import Foundation

/// Version order for ace's own versions: "0.0.25-beta.3" is older than "0.0.25", and newer than
/// "0.0.25-beta.2". A build suffix ("+12") is ignored. Pure, so it is tested directly.
enum AppVersion {
    static func isNewer(_ candidate: String, than current: String) -> Bool {
        guard let a = parse(candidate), let b = parse(current) else { return false }
        for (x, y) in zip(a.core, b.core) where x != y { return x > y }
        if a.core.count != b.core.count { return a.core.count > b.core.count }
        switch (a.pre, b.pre) {
        case ([], []): return false
        case ([], _): return true
        case (_, []): return false
        default: return comparePre(a.pre, b.pre) > 0
        }
    }

    private struct Parsed { let core: [Int]; let pre: [String] }

    private static func parse(_ text: String) -> Parsed? {
        let noBuild = text.split(separator: "+", maxSplits: 1).first.map(String.init) ?? ""
        let parts = noBuild.split(separator: "-", maxSplits: 1).map(String.init)
        guard let head = parts.first else { return nil }
        let nums = head.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        guard !nums.isEmpty, !nums.contains(nil) else { return nil }
        let pre = parts.count > 1 ? parts[1].split(separator: ".").map(String.init) : []
        return Parsed(core: nums.compactMap { $0 }, pre: pre)
    }

    private static func comparePre(_ a: [String], _ b: [String]) -> Int {
        for (x, y) in zip(a, b) where x != y {
            switch (Int(x), Int(y)) {
            case let (i?, j?): return i > j ? 1 : -1
            case (.some, nil): return -1
            case (nil, .some): return 1
            default: return x > y ? 1 : -1
            }
        }
        return a.count == b.count ? 0 : (a.count > b.count ? 1 : -1)
    }
}

/// Where this copy of ace for iPhone came from, and so how it is updated.
enum PhoneInstall: Equatable {
    case appStore, testFlight, development

    /// `receipt` is `Bundle.main.appStoreReceiptURL?.lastPathComponent`.
    static func detect(bundleId: String, receipt: String?) -> PhoneInstall {
        if bundleId.hasSuffix(".dev") { return .development }
        switch receipt {
        case "sandboxReceipt": return .testFlight
        case "receipt": return .appStore
        default: return .development
        }
    }
}

/// What the phone's update row shows and does.
enum PhoneUpdateState: Equatable {
    case development
    case testFlight
    case idle
    case checking
    case upToDate
    case available(version: String, storeURL: URL)
    case failed
}

/// One App Store lookup result; nothing about the person is sent to get it.
struct StoreListing: Equatable, Sendable {
    let version: String
    let trackId: Int
}

enum PhoneUpdate {
    static func lookupURL(bundleId: String) -> URL? {
        var parts = URLComponents(string: "https://itunes.apple.com/lookup")
        parts?.queryItems = [URLQueryItem(name: "bundleId", value: bundleId)]
        return parts?.url
    }

    /// The listing in a lookup response, or nil when the app isn't listed.
    static func listing(from data: Data) -> StoreListing? {
        struct Reply: Decodable {
            struct Item: Decodable { let version: String; let trackId: Int }
            let results: [Item]
        }
        guard let item = (try? JSONDecoder().decode(Reply.self, from: data))?.results.first else { return nil }
        return StoreListing(version: item.version, trackId: item.trackId)
    }

    static func decide(current: String, listing: StoreListing?) -> PhoneUpdateState {
        guard let listing else { return .upToDate }
        guard AppVersion.isNewer(listing.version, than: current),
              let url = URL(string: "itms-apps://apps.apple.com/app/id\(listing.trackId)")
        else { return .upToDate }
        return .available(version: listing.version, storeURL: url)
    }

    static let testFlightURL = URL(string: "itms-beta://")!

    /// The state a build starts in, before any check.
    static func initial(_ install: PhoneInstall) -> PhoneUpdateState {
        switch install {
        case .development: .development
        case .testFlight: .testFlight
        case .appStore: .idle
        }
    }
}

/// Checks the App Store for a newer ace for iPhone. The fetcher is injected.
@MainActor @Observable final class PhoneUpdateModel {
    private(set) var state: PhoneUpdateState
    let install: PhoneInstall
    let version: String
    let build: String
    private let bundleId: String
    private let fetch: @Sendable (URL) async throws -> Data

    init(bundleId: String, version: String, build: String, receipt: String?,
         fetch: @escaping @Sendable (URL) async throws -> Data = { url in try await URLSession.shared.data(from: url).0 }) {
        self.bundleId = bundleId
        self.version = version
        self.build = build
        install = PhoneInstall.detect(bundleId: bundleId, receipt: receipt)
        state = PhoneUpdate.initial(install)
        self.fetch = fetch
    }

    static var current: PhoneUpdateModel {
        let info = Bundle.main.infoDictionary
        return PhoneUpdateModel(
            bundleId: Bundle.main.bundleIdentifier ?? "",
            version: info?["CFBundleShortVersionString"] as? String ?? "0",
            build: info?["CFBundleVersion"] as? String ?? "0",
            receipt: Bundle.main.appStoreReceiptURL?.lastPathComponent)
    }

    func check() async {
        guard install == .appStore, state != .checking, let url = PhoneUpdate.lookupURL(bundleId: bundleId) else { return }
        state = .checking
        do {
            let data = try await fetch(url)
            state = PhoneUpdate.decide(current: version, listing: PhoneUpdate.listing(from: data))
        } catch {
            state = .failed
        }
    }
}
