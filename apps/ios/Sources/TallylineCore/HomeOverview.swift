import Foundation

/// The last recorded action on a Home project card. `asOf` is set only when
/// the source summary is older than `NowFeed.staleAfter`; the line never
/// claims to be fresher than the data it came from.
public struct HomeActivityLine: Equatable, Sendable {
    public let sentence: String
    public let at: Date
    public let asOf: Date?

    public init(sentence: String, at: Date, asOf: Date? = nil) {
        self.sentence = sentence
        self.at = at
        self.asOf = asOf
    }

    /// The sentence, with "as of <time>" appended when the source is stale.
    public func displayText(date: (Date) -> String = HomeOverview.clockTime) -> String {
        guard let asOf else { return sentence }
        return "\(sentence) · as of \(date(asOf))"
    }
}

/// One active project on the Home screen.
public struct HomeProjectCard: Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let done: Int
    public let total: Int
    public let openCount: Int
    public let inProgress: Int
    public let inReview: Int
    public let lastActivity: HomeActivityLine?

    public init(
        id: String, name: String, done: Int, total: Int, openCount: Int,
        inProgress: Int, inReview: Int, lastActivity: HomeActivityLine?
    ) {
        self.id = id
        self.name = name
        self.done = done
        self.total = total
        self.openCount = openCount
        self.inProgress = inProgress
        self.inReview = inReview
        self.lastActivity = lastActivity
    }

    public var fraction: Double { ProgressMath.fraction(done: done, total: total) }

    /// One VoiceOver sentence: name, open work, last activity, and "as of"
    /// when the source is stale.
    public func accessibilityLabel(date: (Date) -> String = HomeOverview.clockTime) -> String {
        var parts = [name, "\(openCount) open", "\(done) of \(total) done"]
        if let lastActivity {
            parts.append(lastActivity.displayText(date: date))
        }
        return parts.joined(separator: ", ")
    }
}

/// An in-progress issue an agent is on, for the compact "agents working" strip.
public struct HomeWorkingItem: Equatable, Identifiable, Sendable {
    public let agentId: String
    public let issueKey: String
    public let issueTitle: String
    public var id: String { "\(agentId):\(issueKey)" }

    public init(agentId: String, issueKey: String, issueTitle: String) {
        self.agentId = agentId
        self.issueKey = issueKey
        self.issueTitle = issueTitle
    }

    /// Key and title only. The issue does not carry an agent name, so this
    /// line does not invent one.
    public var line: String { "\(issueKey) · \(issueTitle)" }
}

public enum HomeOverview {
    /// A short clock time for "as of" labels. Fixed `.short` style so tests
    /// can inject their own formatter and the UI never says "just now".
    public static func clockTime(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeStyle = .short
        formatter.dateStyle = .none
        return formatter.string(from: date)
    }

    /// A project is active unless it is completed or canceled.
    public static func isActive(_ project: Project) -> Bool {
        let status = project.status ?? "planned"
        return status != "completed" && status != "canceled"
    }

    /// Active projects, most recent activity first, then name. A project with
    /// no recorded activity sorts after those that have some. Counts come from
    /// the server summary, never from whichever issues the phone happens to hold.
    public static func cards(
        projects: [Project],
        summary: RoadmapSummary?,
        fetchedAt: Date?,
        now: Date = Date()
    ) -> [HomeProjectCard] {
        let stale = fetchedAt.map { now.timeIntervalSince($0) > NowFeed.staleAfter } ?? false
        let asOf = (stale ? fetchedAt : nil)
        let latest: [String: RoadmapSummary.Merge] = Dictionary(
            (summary?.merges ?? []).compactMap { merge in
                guard let projectId = merge.projectId else { return nil }
                return (projectId, merge)
            },
            uniquingKeysWith: { a, b in a.at >= b.at ? a : b }
        )
        return projects.filter(isActive).map { project in
            let counts = summary?.counts(forProject: project.id) ?? .zero(project.id)
            let merge = latest[project.id]
            let activity = merge.map {
                HomeActivityLine(sentence: NowFeed.sentence(for: $0), at: $0.at, asOf: asOf)
            }
            return HomeProjectCard(
                id: project.id,
                name: project.name,
                done: counts.done,
                total: counts.total,
                openCount: max(0, counts.total - counts.done - counts.closed),
                inProgress: counts.inProgress,
                inReview: counts.inReview,
                lastActivity: activity
            )
        }
        .sorted(by: isBefore)
    }

    /// One row per agent currently on an in-progress issue, showing that
    /// agent's most recently updated issue. Name is omitted because the issue
    /// row does not carry one.
    public static func workingAgents(in issues: [Issue]) -> [HomeWorkingItem] {
        var best: [String: Issue] = [:]
        for issue in issues {
            guard issue.state == .inProgress else { continue }
            let agentId: String?
            if issue.assigneeType == "agent" { agentId = issue.assigneeId }
            else if issue.delegateType == "agent" { agentId = issue.delegateId }
            else { agentId = nil }
            guard let agentId else { continue }
            if let existing = best[agentId], existing.updatedAt >= issue.updatedAt { continue }
            best[agentId] = issue
        }
        return best.keys.sorted().compactMap { id in
            guard let issue = best[id] else { return nil }
            return HomeWorkingItem(agentId: id, issueKey: issue.key, issueTitle: issue.title)
        }
    }

    private static func isBefore(_ a: HomeProjectCard, _ b: HomeProjectCard) -> Bool {
        switch (a.lastActivity?.at, b.lastActivity?.at) {
        case let (x?, y?) where x != y: return x > y
        case (_?, nil): return true
        case (nil, _?): return false
        default:
            let names = a.name.localizedCaseInsensitiveCompare(b.name)
            if names != .orderedSame { return names == .orderedAscending }
            return a.id < b.id
        }
    }
}
