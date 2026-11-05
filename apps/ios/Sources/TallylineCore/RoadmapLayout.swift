import Foundation

/// A span on the roadmap: a project, a cycle, or a single milestone date.
public struct RoadmapSpan: Identifiable, Equatable, Sendable {
    public enum Lane: Int, Sendable, CaseIterable {
        case cycles, projects, milestones

        public var title: String {
            switch self {
            case .cycles: "Cycles"
            case .projects: "Projects"
            case .milestones: "Milestones"
            }
        }
    }

    public let id: String
    public let lane: Lane
    public let title: String
    public let start: Date
    public let end: Date
    /// Exact counts from the server; nil where the API has none (cycles).
    public let done: Int?
    public let total: Int?
}

public enum RoadmapLayout {
    /// Builds the spans. A project with no dates is open-ended: it runs from
    /// when it was created to `now`. A milestone with no date is left off.
    public static func spans(
        projects: [Project], milestones: [Milestone], cycles: [Cycle],
        summary: RoadmapSummary?, now: Date = Date(), calendar: Calendar = .current
    ) -> [RoadmapSpan] {
        var out: [RoadmapSpan] = []
        for cycle in cycles {
            guard let start = cycle.startsAt, let end = cycle.endsAt, end >= start else { continue }
            out.append(RoadmapSpan(id: "cycle:\(cycle.id)", lane: .cycles, title: cycle.name ?? cycle.number.map { "Cycle \($0)" } ?? "Cycle", start: start, end: end, done: nil, total: nil))
        }
        for project in projects {
            let start = project.startDate ?? project.createdAt ?? now
            var end = project.targetDate ?? max(now, start)
            if end < start { end = start }
            let counts = summary?.counts(forProject: project.id)
            out.append(RoadmapSpan(id: "project:\(project.id)", lane: .projects, title: project.name, start: start, end: end, done: counts?.done, total: counts?.total))
        }
        let names = Dictionary(uniqueKeysWithValues: projects.map { ($0.id, $0.name) })
        for milestone in milestones {
            guard let date = milestone.targetDate else { continue }
            let counts = summary?.counts(forMilestone: milestone.id)
            let title = names[milestone.projectId].map { "\($0): \(milestone.title)" } ?? milestone.title
            out.append(RoadmapSpan(id: "milestone:\(milestone.id)", lane: .milestones, title: title, start: date, end: date, done: counts?.done ?? milestone.progress?.done, total: counts?.total ?? milestone.progress?.total))
        }
        return out
    }

    /// First-of-month dates covering every span and today, with a month of
    /// padding either side so bars never touch the edge.
    public static func months(for spans: [RoadmapSpan], now: Date = Date(), calendar: Calendar = .current) -> [Date] {
        var lo = now, hi = now
        for span in spans {
            lo = min(lo, span.start)
            hi = max(hi, span.end)
        }
        func monthStart(_ date: Date) -> Date {
            calendar.date(from: calendar.dateComponents([.year, .month], from: date)) ?? date
        }
        let first = calendar.date(byAdding: .month, value: -1, to: monthStart(lo)) ?? monthStart(lo)
        let last = calendar.date(byAdding: .month, value: 1, to: monthStart(hi)) ?? monthStart(hi)
        var months: [Date] = []
        var cursor = first
        while cursor <= last, months.count < 120 {
            months.append(cursor)
            guard let next = calendar.date(byAdding: .month, value: 1, to: cursor) else { break }
            cursor = next
        }
        return months
    }

    /// Where a date sits across the month grid, in units of months from the
    /// first month's start (a date mid-June is 5.5 when June is the sixth).
    public static func position(of date: Date, in months: [Date], calendar: Calendar = .current) -> Double {
        guard let first = months.first else { return 0 }
        let clamped = max(date, first)
        var index = 0
        for (i, month) in months.enumerated() where month <= clamped { index = i }
        let start = months[index]
        let end = calendar.date(byAdding: .month, value: 1, to: start) ?? start
        let span = end.timeIntervalSince(start)
        let within = span > 0 ? min(1, max(0, clamped.timeIntervalSince(start) / span)) : 0
        return Double(index) + within
    }

    /// The index of the month holding `date`, nil outside the grid.
    public static func monthIndex(of date: Date, in months: [Date], calendar: Calendar = .current) -> Int? {
        months.firstIndex { calendar.isDate(date, equalTo: $0, toGranularity: .month) }
    }
}

public enum ProjectOrdering {
    private static let rank: [String: Int] = ["started": 0, "planned": 1, "paused": 2, "backlog": 3, "completed": 4, "canceled": 5]

    /// Active first, then by target date (soonest first, undated last), then name.
    public static func sorted(_ projects: [Project]) -> [Project] {
        projects.sorted { a, b in
            let ra = rank[a.status ?? ""] ?? 9, rb = rank[b.status ?? ""] ?? 9
            if ra != rb { return ra < rb }
            switch (a.targetDate, b.targetDate) {
            case let (x?, y?) where x != y: return x < y
            case (_?, nil): return true
            case (nil, _?): return false
            default: return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
            }
        }
    }

    public static func label(_ status: String?) -> String {
        switch status {
        case "started": "Active"
        case "planned": "Planned"
        case "paused": "Paused"
        case "backlog": "Backlog"
        case "completed": "Completed"
        case "canceled": "Canceled"
        default: "Planned"
        }
    }
}
