import SwiftUI
import UIKit

/// `usage.combine` (`bridge/usage-report.ts`): the web Usage page's Cost and Tokens views over
/// every machine in scope, summed and worded by `@ace/ui-core`, for Swift only to draw.
struct UsageReportReply: Decodable, Sendable {
    struct Provider: Decodable, Sendable, Hashable { let id: String; let name: String }
    let from: String
    let to: String
    let providers: [Provider]
    let coverage: UsageCoverage
    let tokens: UsageMetricView
    let cost: UsageMetricView
}

/// Which machines the figures count: "2 of 3 machines · Studio is offline"; null for one
/// counted machine.
struct UsageCoverage: Decodable, Sendable, Hashable {
    let line: String?
    let complete: Bool
}

struct UsageHue: Decodable, Sendable, Hashable {
    let light: String
    let dark: String
}

struct UsageGrowth: Decodable, Sendable, Hashable {
    /// "up", "down", "flat", "new" or "none" (nothing to compare).
    let direction: String
    let label: String
}

struct UsageMetricView: Decodable, Sendable {
    struct ProviderLine: Decodable, Sendable, Hashable, Identifiable {
        let id: String
        let name: String
        let hue: UsageHue?
        let ink: Bool
        let figure: String
        let detail: String
        let sessions: String
        let growth: UsageGrowth
    }
    struct Chart: Decodable, Sendable {
        struct Tick: Decodable, Sendable, Hashable { let value: Double; let label: String }
        struct Series: Decodable, Sendable, Hashable { let id: String; let name: String; let hue: UsageHue?; let ink: Bool }
        struct Day: Decodable, Sendable, Hashable {
            let day: String
            let label: String
            let title: String
            let values: [Double]
            let texts: [String]
        }
        let title: String
        let axis: [Tick]
        let top: Double
        let summary: String
        let series: [Series]
        let days: [Day]
    }
    struct Stat: Decodable, Sendable, Hashable { let label: String; let value: String }
    struct Types: Decodable, Sendable {
        struct Part: Decodable, Sendable, Hashable { let key: String; let label: String; let value: Double; let text: String }
        let title: String
        let parts: [Part]
    }
    struct Line: Decodable, Sendable, Hashable, Identifiable {
        var id: String { key }
        let key: String
        let name: String
        let provider: String?
        let hue: UsageHue?
        let ink: Bool
        let figure: String
        let share: String
        let other: String
        let fraction: Double
    }
    struct Unpriced: Decodable, Sendable { let label: String; let lines: [Line] }
    let total: String
    let growth: UsageGrowth
    let basis: String
    let sessions: String
    let note: String?
    let providers: [ProviderLine]
    let chart: Chart
    let totals: [Stat]
    let types: Types
    let byModel: [Line]
    let byDay: [Line]
    let unpriced: Unpriced?
}

/// `usage.useReset`: what redeeming a banked reset did, in the web's words.
struct UsageResetReply: Decodable, Sendable {
    let outcome: String
    let words: String
}

/// `usage.combineLimits` (`bridge/usage-limits.ts`): the shared Usage-page limits, worded by
/// `@ace/ui-core`, for Swift to draw beside the token use.
struct UsageLimitsReply: Decodable, Sendable {
    struct Pace: Codable, Sendable, Hashable {
        let label: String
        let token: String
    }
    struct Window: Codable, Sendable, Hashable {
        let id: String
        let label: String
        let leftPercent: Double
        let resets: String?
        let resetsAt: Double?
        let observedAt: Double
        let stale: Bool
        let old: Bool
        let pace: Pace?
    }
    struct Account: Codable, Sendable, Hashable {
        let key: String
        let instanceId: String?
        /// The machine a banked reset goes through.
        let machineId: String?
        /// "Studio", or "Mac and Studio" for one login on both; nil with a single machine.
        let machine: String?
        let provider: String?
        let label: String
        let plan: String?
        let signIn: String?
        let bankedResets: Double?
        let bankedExpiresAt: Double?
        let noSessionWindow: Bool
        let windows: [Window]
    }
    struct Provider: Codable, Sendable, Hashable {
        let key: String
        let provider: String
        let providerLabel: String
        let accounts: [Account]
    }
    let providers: [Provider]
    let quiet: [String]
    /// Logins ace can't tell apart across machines, said once each.
    let unsure: [String]
    let coverage: UsageCoverage
}

/// A provider's hue on the Usage screen: its own light and dark colour, the theme's ink for
/// Codex, or the muted ink for any provider without one.
enum UsageColour {
    @MainActor static func of(_ hue: UsageHue?, ink: Bool) -> Color {
        guard let hue, let light = rgb(hue.light), let dark = rgb(hue.dark) else {
            return ink ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground
        }
        return Color(uiColor: UIColor { @Sendable traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255,
                           blue: CGFloat(value & 255) / 255, alpha: 1)
        })
    }
    private static func rgb(_ hex: String) -> UInt32? {
        UInt32(hex.hasPrefix("#") ? String(hex.dropFirst()) : hex, radix: 16)
    }
}
