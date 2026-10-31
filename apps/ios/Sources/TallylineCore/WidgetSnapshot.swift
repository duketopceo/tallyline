import Foundation

/// What the Home Screen and Lock Screen widgets show. The app builds it from
/// the local issue cache and writes it to the shared App Group container; the
/// widget only ever reads this file, never the network.
public struct WidgetSnapshot: Codable, Sendable, Equatable {
    public struct Row: Codable, Sendable, Equatable, Identifiable {
        public let id: String
        public let key: String
        public let title: String
        public let state: IssueState
        public let priority: IssuePriority

        public init(id: String, key: String, title: String, state: IssueState, priority: IssuePriority) {
            self.id = id
            self.key = key
            self.title = title
            self.state = state
            self.priority = priority
        }
    }

    public struct CycleProgress: Codable, Sendable, Equatable {
        public let name: String
        public let done: Int
        public let total: Int
        public let endsAt: Date?

        public init(name: String, done: Int, total: Int, endsAt: Date?) {
            self.name = name
            self.done = done
            self.total = total
            self.endsAt = endsAt
        }

        /// 0...1; an empty cycle reads as 0.
        public var fraction: Double { total == 0 ? 0 : Double(done) / Double(total) }
    }

    public var workspaceName: String
    public var generatedAt: Date
    /// The first few open issues assigned to me, most urgent first.
    public var myIssues: [Row]
    public var myIssueCount: Int
    public var reviewCount: Int
    public var cycle: CycleProgress?

    public init(workspaceName: String, generatedAt: Date, myIssues: [Row], myIssueCount: Int, reviewCount: Int, cycle: CycleProgress?) {
        self.workspaceName = workspaceName
        self.generatedAt = generatedAt
        self.myIssues = myIssues
        self.myIssueCount = myIssueCount
        self.reviewCount = reviewCount
        self.cycle = cycle
    }

    public static let rowLimit = 5
    public static let appGroup = "group.app.tallyline.ios"

    static let closed: Set<IssueState> = [.done, .canceled, .duplicate]

    static func rank(_ p: IssuePriority) -> Int {
        switch p {
        case .urgent: 0
        case .high: 1
        case .medium: 2
        case .low: 3
        case .none: 4
        }
    }

    public static func build(
        workspaceName: String,
        userId: String,
        issues: [Issue],
        reviewCount: Int,
        cycles: [Cycle],
        now: Date = Date()
    ) -> WidgetSnapshot {
        let mine = issues
            .filter { $0.assigneeId == userId && $0.assigneeType != "agent" && !closed.contains($0.state) }
            .sorted { a, b in
                rank(a.priority) != rank(b.priority) ? rank(a.priority) < rank(b.priority) : a.updatedAt > b.updatedAt
            }
        return WidgetSnapshot(
            workspaceName: workspaceName,
            generatedAt: now,
            myIssues: mine.prefix(rowLimit).map { Row(id: $0.id, key: $0.key, title: $0.title, state: $0.state, priority: $0.priority) },
            myIssueCount: mine.count,
            reviewCount: reviewCount,
            cycle: currentCycle(cycles, now: now).map { progress(of: $0, issues: issues) }
        )
    }

    /// The flagged active cycle, else the one whose dates contain `now`.
    static func currentCycle(_ cycles: [Cycle], now: Date) -> Cycle? {
        if let active = cycles.first(where: \.isActive) { return active }
        return cycles.first { c in
            guard let start = c.startsAt, let end = c.endsAt else { return false }
            return start <= now && now < end
        }
    }

    static func progress(of cycle: Cycle, issues: [Issue]) -> CycleProgress {
        let inCycle = issues.filter { $0.cycleId == cycle.id && $0.state != .canceled && $0.state != .duplicate }
        let name = cycle.name ?? cycle.number.map { "Cycle \($0)" } ?? "Current cycle"
        return CycleProgress(name: name, done: inCycle.filter { $0.state == .done }.count, total: inCycle.count, endsAt: cycle.endsAt)
    }

    /// Shown in the widget gallery and while the app has not written a file yet.
    public static let placeholder = WidgetSnapshot(
        workspaceName: "Tallyline",
        generatedAt: Date(timeIntervalSince1970: 0),
        myIssues: [
            Row(id: "1", key: "APP-12", title: "Fix the sign-in banner", state: .inProgress, priority: .high),
            Row(id: "2", key: "APP-9", title: "Write the release notes", state: .todo, priority: .medium),
            Row(id: "3", key: "APP-4", title: "Tidy the settings screen", state: .backlog, priority: .low),
        ],
        myIssueCount: 3,
        reviewCount: 2,
        cycle: CycleProgress(name: "Cycle 4", done: 7, total: 12, endsAt: nil)
    )

    /// The snapshot file in the App Group container, or nil when the group is
    /// not available (unsigned builds, Linux).
    public static func sharedStore(fileManager: FileManager = .default) -> JSONFileStore<WidgetSnapshot>? {
        #if canImport(Darwin)
        guard let dir = fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
        return .standard(named: "widget", in: dir)
        #else
        return nil
        #endif
    }
}

/// `tallyline://open/<destination>` links from widgets, shortcuts and pushes.
public enum AppLink {
    public static func url(_ destination: PushDestination) -> URL {
        URL(string: "tallyline://open/\(destination == .review ? "review" : "issues")")!
    }

    public static func destination(_ url: URL) -> PushDestination? {
        guard url.scheme == "tallyline", url.host == "open" else { return nil }
        switch url.path {
        case "/issues": return .myIssues
        case "/review": return .review
        default: return nil
        }
    }
}
