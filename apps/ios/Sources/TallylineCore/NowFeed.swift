import Foundation

/// One line in the Now feed.
public struct NowItem: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// A write the phone could not send and gave up on.
        case parkedWrite
        /// An issue waiting for a human decision.
        case reviewRequest
        /// An issue an agent or person finished, with the merged PR if any.
        case finished(prNumber: Int?)
    }

    public let id: String
    public let kind: Kind
    public let at: Date
    /// The issue to open, if there is one.
    public let issueKey: String?
    /// One sentence: who, what, which issue.
    public let sentence: String
    public let byAgent: Bool
    /// Set when the data behind this row is older than `NowFeed.staleAfter`.
    public var asOf: Date?
}

public enum NowGroup: String, CaseIterable, Sendable {
    case needsYou, today, yesterday, earlier

    public var title: String {
        switch self {
        case .needsYou: "Needs you"
        case .today: "Today"
        case .yesterday: "Yesterday"
        case .earlier: "Earlier"
        }
    }
}

public struct NowSection: Identifiable, Equatable, Sendable {
    public let group: NowGroup
    public let items: [NowItem]
    public var id: String { group.rawValue }
}

public enum NowFeed {
    /// Data older than this is marked "as of".
    public static let staleAfter: TimeInterval = 300

    /// Builds the feed from what the sync already holds. Parked writes lead;
    /// everything else is newest first, ties broken by id so the order is
    /// stable between refreshes.
    public static func items(
        merges: [RoadmapSummary.Merge],
        review: [ReviewQueueEntry],
        outbox: [OutboxEntry],
        fetchedAt: Date?,
        now: Date = Date()
    ) -> [NowItem] {
        var out: [NowItem] = []
        for entry in outbox where entry.displayState == .parked {
            out.append(NowItem(
                id: "parked:\(entry.id)", kind: .parkedWrite, at: entry.createdAt,
                issueKey: entry.operation.issueKey,
                sentence: "Not sent: \(entry.operation.summary)", byAgent: false
            ))
        }
        for entry in review {
            out.append(NowItem(
                id: "review:\(entry.id)", kind: .reviewRequest, at: entry.sessionAt, issueKey: entry.key,
                sentence: "\(entry.agentName) finished \(entry.key), waiting for your review", byAgent: true
            ))
        }
        for merge in merges {
            let who = merge.actorName ?? (merge.actorType == "agent" ? "An agent" : "Someone")
            let sentence: String
            if let pr = merge.pr {
                sentence = "\(who) merged #\(pr.number) for \(merge.issueKey)"
            } else {
                sentence = "\(who) finished \(merge.issueKey)"
            }
            out.append(NowItem(
                id: "merge:\(merge.id)", kind: .finished(prNumber: merge.pr?.number), at: merge.at,
                issueKey: merge.issueKey, sentence: sentence, byAgent: merge.actorType == "agent"
            ))
        }
        let stale = fetchedAt.map { now.timeIntervalSince($0) > staleAfter } ?? false
        if stale, let fetchedAt {
            out = out.map { item in
                var copy = item
                if item.kind != .parkedWrite { copy.asOf = fetchedAt }
                return copy
            }
        }
        return out.sorted { a, b in
            if (a.kind == .parkedWrite) != (b.kind == .parkedWrite) { return a.kind == .parkedWrite }
            if a.at != b.at { return a.at > b.at }
            return a.id < b.id
        }
    }

    public static func grouped(_ items: [NowItem], now: Date = Date(), calendar: Calendar = .current) -> [NowSection] {
        func group(for item: NowItem) -> NowGroup {
            if item.kind == .parkedWrite { return .needsYou }
            if calendar.isDate(item.at, inSameDayAs: now) { return .today }
            if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(item.at, inSameDayAs: yesterday) { return .yesterday }
            return .earlier
        }
        let buckets = Dictionary(grouping: items, by: group(for:))
        return NowGroup.allCases.compactMap { g in
            guard let rows = buckets[g], !rows.isEmpty else { return nil }
            return NowSection(group: g, items: rows)
        }
    }
}

public extension OutboxOperation {
    /// The issue a queued write targets, when it targets one.
    var issueKey: String? {
        switch self {
        case .createIssue: nil
        case .updateIssue(let key, _), .addComment(let key, _): key
        }
    }
}

/// The one-line agent pulse at the foot of the shell.
public struct PulseSummary: Equatable, Sendable {
    public var agentsWorking: Int
    public var inReview: Int
    public var waitingToSend: Int
    public var online: Bool
    public var asOf: Date?

    public init(agentsWorking: Int, inReview: Int, waitingToSend: Int, online: Bool, asOf: Date? = nil) {
        self.agentsWorking = agentsWorking; self.inReview = inReview
        self.waitingToSend = waitingToSend; self.online = online; self.asOf = asOf
    }

    /// Agents on issues that are in progress, counted once each.
    public static func agentsWorking(in issues: [Issue]) -> Int {
        Set(issues.compactMap { issue -> String? in
            guard issue.state == .inProgress else { return nil }
            if issue.assigneeType == "agent", let id = issue.assigneeId { return id }
            if issue.delegateType == "agent", let id = issue.delegateId { return id }
            return nil
        }).count
    }

    /// "2 agents working · 3 in review · 1 waiting to send", only the
    /// non-zero parts; "Up to date" when there are none; "Offline ·" leads when
    /// there is no network.
    public var text: String {
        var parts: [String] = []
        if agentsWorking > 0 { parts.append("\(agentsWorking) agent\(agentsWorking == 1 ? "" : "s") working") }
        if inReview > 0 { parts.append("\(inReview) in review") }
        if waitingToSend > 0 { parts.append("\(waitingToSend) waiting to send") }
        let body = parts.isEmpty ? "Up to date" : parts.joined(separator: " · ")
        return online ? body : "Offline · \(body)"
    }

    public var isIdle: Bool { agentsWorking == 0 }

    /// Where a tap goes: Review when something waits there, else the Outbox.
    public var tapTarget: Target { inReview > 0 ? .review : .outbox }

    public enum Target: Sendable { case review, outbox }
}
