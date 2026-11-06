import Foundation

/// Links to issues: what "Copy link" copies and what a tapped link opens.
public enum IssueLink {
    /// The link to copy, exactly as the API gave it. Nil hides the action:
    /// a server that predates the `url` field, or a value that is not a
    /// web link, gets no Copy link rather than one assembled here.
    public static func copyable(_ issue: Issue) -> String? {
        guard let raw = issue.url?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
              let url = URL(string: raw), url.scheme == "https" || url.scheme == "http", url.host != nil
        else { return nil }
        return raw
    }

    /// The key in `https://<web host>/issues/<KEY>`, or nil when the URL is
    /// not an issue link on one of `hosts`. Case-insensitive on the key so a
    /// hand-typed link still resolves; any query or fragment is ignored.
    public static func key(fromUniversalLink url: URL, webHosts hosts: Set<String> = TallylineConfig.webHosts) -> String? {
        guard url.scheme == "https", let host = url.host?.lowercased(), hosts.contains(host) else { return nil }
        let parts = url.path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard parts.count == 2, parts[0] == "issues", let key = parts[1].removingPercentEncoding else { return nil }
        // normalize also accepts "eng 12" and "eng12"; a link path must be a real key.
        guard key.contains("-") else { return nil }
        return IssueKey.normalize(key)
    }
}

/// What the issue loader shows when it cannot open a key.
public struct IssueLoadFailure: Equatable, Sendable {
    public let title: String
    public let detail: String
    public let isNotFound: Bool

    public static func describe(_ error: Error, key: String) -> IssueLoadFailure {
        if case let APIClientError.http(status, _, _) = error, status == 404 {
            return IssueLoadFailure(title: "\(key) not found", detail: "It may have been deleted, or you may not have access to it.", isNotFound: true)
        }
        return IssueLoadFailure(title: "Could not load \(key)", detail: error.localizedDescription, isNotFound: false)
    }
}

/// The issues the Blocked rotor visits. The rotor is only offered when this
/// is non-empty, so VoiceOver never lists an empty category.
public enum BlockedIssues {
    public static func filter(_ issues: [Issue]) -> [Issue] {
        issues.filter { $0.blocked == true }
    }

    /// Feed rows about a blocked issue, in feed order.
    public static func items(_ items: [NowItem], blockedKeys: Set<String>) -> [NowItem] {
        items.filter { $0.issueKey.map(blockedKeys.contains) ?? false }
    }

    /// Keys of blocked issues, for lists that hold feed items rather than issues.
    public static func keys(_ issues: [Issue]) -> Set<String> {
        Set(filter(issues).map(\.key))
    }
}

/// Where a roadmap scroll may come to rest: the left edge of each milestone,
/// plus the start of the grid.
public enum RoadmapSnap {
    /// Sorted, de-duplicated x offsets in points. `inset` leaves a little room
    /// before the milestone.
    public static func offsets(spans: [RoadmapSpan], months: [Date], monthWidth: Double, inset: Double = 16, calendar: Calendar = .current) -> [Double] {
        var xs: Set<Double> = [0]
        for span in spans where span.lane == .milestones {
            let x = RoadmapLayout.position(of: span.start, in: months, calendar: calendar) * monthWidth - inset
            xs.insert(max(0, x.rounded()))
        }
        return xs.sorted()
    }

    /// The offset a scroll aimed at `target` should settle on, within `maxOffset`.
    public static func settle(_ target: Double, among offsets: [Double], maxOffset: Double) -> Double {
        let clamped = min(max(0, target), max(0, maxOffset))
        let reachable = offsets.filter { $0 <= maxOffset }
        guard let best = reachable.min(by: { abs($0 - clamped) < abs($1 - clamped) }) else { return clamped }
        return best
    }
}
