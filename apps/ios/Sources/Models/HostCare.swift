import Foundation

/// `machine.admission` (`bridge/machine-admission.ts`): whether the machine takes new work, with
/// the shared words for it. `known` is false when its ace predates pausing from a phone.
struct MachineAdmissionInfo: Codable, Sendable, Equatable {
    let known: Bool
    let paused: Bool
    /// "New work paused · 1 thread is finishing"; nil while it takes new work.
    let line: String?
    /// "Pause new work" or "Resume new work".
    let action: String
}

/// `machine.appUpdate` (`bridge/machine-app-update.ts`): the desktop app's update, read-only.
/// `known` is false when the machine's ace predates the report; `version` reads "Unknown" when
/// no desktop app has reported.
struct MachineAppUpdateInfo: Codable, Sendable, Equatable {
    let known: Bool
    let version: String
    /// "Up to date", "Update 1.4.2 available" or "Restart to finish updating".
    let line: String?
    /// Restart required: the one state that needs the person.
    let needsYou: Bool
}

/// `host.storage` (`bridge/host-storage.ts`): one machine's Storage page, already worded.
struct StoragePage: Decodable, Sendable, Equatable {
    struct Row: Decodable, Sendable, Equatable, Identifiable { let kind: String; let title: String; let detail: String; let size: String; var id: String { kind } }
    struct Database: Decodable, Sendable, Equatable { let size: String; let detail: String }
    struct Backups: Decodable, Sendable, Equatable { let line: String; let paths: [String] }
    struct Usage: Decodable, Sendable, Equatable { let rows: [Row]; let database: Database; let partial: String?; let backups: Backups? }
    struct Pinned: Decodable, Sendable, Equatable { let value: Double; let pinnedBy: String? }
    struct Kind: Decodable, Sendable, Equatable, Identifiable { let kind: String; let title: String; let days: Double?; let note: String?; var id: String { kind } }
    struct Settings: Decodable, Sendable, Equatable {
        let retentionDays: Pinned
        let logMegabytes: Pinned
        let worktreeDays: Double?
        let backupWorktrees: Bool
        let scheduledCleanup: Bool
        let kinds: [Kind]
    }
    let usage: Usage?
    let usageProblem: String?
    let settings: Settings
}

/// `host.storage.plan`: a cleanup preview, and after a removal what happened to each item.
struct StoragePlanReply: Decodable, Sendable { let plan: StoragePlanView }
struct StoragePlanView: Decodable, Sendable, Equatable {
    struct Item: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let label: String
        let size: String
        let removes: Bool
        let line: String
        let also: String?
        let forceable: Bool
        let forced: Bool
        let outcome: String?
    }
    struct Confirm: Decodable, Sendable, Equatable { let title: String; let message: String; let button: String }
    let id: String
    let title: String
    let summary: String
    let items: [Item]
    /// The red action's words; nil when nothing can be removed.
    let action: String?
    let confirm: Confirm?
    let outcome: String?
}

/// `host.storage.compaction`: where compaction stands, and the id to stop one still running.
struct StorageCompactionReply: Decodable, Sendable { let line: String; let pendingId: String? }

/// `host.diagnostics` (`bridge/host-diagnostics.ts`).
struct HostDiagnosticsPage: Decodable, Sendable, Equatable {
    struct Row: Decodable, Sendable, Equatable, Hashable { let label: String; let value: String }
    struct Queue: Decodable, Sendable, Equatable, Hashable { let name: String; let depth: Double }
    struct Health: Decodable, Sendable, Equatable { let rows: [Row]; let queues: [Queue]; let json: String }
    struct Timeout: Decodable, Sendable, Equatable { let minutes: Double; let pinnedBy: String? }
    let health: Health?
    let healthProblem: String?
    let worktreeTimeout: Timeout?
}

/// `host.checks`: the read-only setup checks, worded.
struct HostChecksReply: Decodable, Sendable, Equatable {
    struct Row: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let label: String
        let status: String
        let word: String
        let message: String
        let fix: String?
    }
    let summary: String
    let rows: [Row]
}

/// `host.support`: the support bundle, base64, for the share sheet.
struct HostSupportReply: Decodable, Sendable { let name: String; let data: String }
