import Foundation

/// A provider's Settings page as the bridge words it (`bridge/provider-page-view.ts`).
struct ProviderPageData: Decodable, Equatable {
    struct Fix: Decodable, Equatable { let action: String; let label: String }
    struct Terminal: Decodable, Equatable { let run: String; let prompt: String? }
    struct Fact: Decodable, Equatable, Identifiable { let term: String; let value: String; let code: Bool; var id: String { term } }
    struct Option: Decodable, Equatable, Identifiable { let id: String; let label: String }
    struct NativeMode: Decodable, Equatable { let value: String; let label: String; let options: [Option] }
    struct Settings: Decodable, Equatable {
        let enabled: Bool
        let path: String?
        let approvedCommand: String?
        let checkpoint: String?
        let nativeMode: NativeMode?
        let removable: Bool
    }
    let provider: String
    let name: String
    let version: String?
    let update: String?
    let status: StatusDisplay
    let detail: String?
    let fix: Fix?
    let missing: Bool
    let off: Bool
    let accounts: Bool
    let signOut: Bool
    let apiKey: String?
    let terminal: Terminal?
    let about: [Fact]
    let settings: Settings
    let models: ProviderModelsData?
    static func read(_ provider: String) -> [String: Any] { ["type": "provider.page", "provider": provider] }
}

struct ProviderModelsData: Decodable, Equatable {
    struct Choice: Decodable, Equatable { let key: String; let id: String; let label: String; let current: Bool }
    struct DefaultModel: Decodable, Equatable { let label: String; let note: String?; let resettable: Bool; let choices: [Choice] }
    struct Row: Decodable, Equatable {
        let key: String; let id: String; let aliases: [String]; let label: String; let marks: String?; let hidden: Bool; let starred: Bool
    }
    struct Group: Decodable, Equatable, Identifiable { let id: String; let label: String?; let models: [Row] }
    struct Custom: Decodable, Equatable, Identifiable { let id: String; let displayName: String }
    let problems: [String]
    let defaultModel: DefaultModel?
    let shown: String
    let total: String
    let hideDeprecated: Bool
    let onlyFavourites: Bool
    let groups: [Group]
    let custom: [Custom]
}

/// Providers that are turned off or not installed (`providers.others`).
struct OtherProvidersData: Decodable, Equatable {
    struct Row: Decodable, Equatable, Identifiable { let provider: String; let name: String; let detail: String?; let installable: Bool; var id: String { provider } }
    let off: [Row]
    let missing: [Row]
    static var read: [String: Any] { ["type": "providers.others"] }
}

/// An edit's answer: saved, or why not (`provider.edit`).
struct ProviderEditReply: Decodable { let ok: Bool; let message: String? }

/// The install area of a provider's page (`bridge/provider-install.ts`).
struct InstallScreenData: Decodable, Equatable {
    struct Fact: Decodable, Equatable, Identifiable { let term: String; let value: String; var id: String { term } }
    struct Confirm: Decodable, Equatable { let label: String; let destructive: Bool }
    struct Retry: Decodable, Equatable { let action: String }
    struct Link: Decodable, Equatable { let label: String; let url: String }
    let revision: Int
    let idle: Bool
    let title: String
    let status: StatusDisplay?
    let busy: Bool
    let facts: [Fact]
    let lines: [String]
    let message: String?
    let confirm: Confirm?
    let cancel: Bool
    let retry: Retry?
    let link: Link?
    let finished: Bool
    let changed: Bool
}

extension ClientModel {
    /// Changes one of a provider's preferences; throws the bridge's words when it can't be saved.
    func editProvider(_ provider: String, _ change: [String: Any]) async throws {
        let reply = try await service(["type": "provider.edit", "provider": provider, "change": change], as: ProviderEditReply.self)
        if !reply.ok { throw ServiceFailure(message: reply.message ?? "Couldn't save. Try again.") }
    }
}
