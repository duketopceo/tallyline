import Foundation

/// A write made while offline (or that failed in flight), replayed later.
public enum OutboxOperation: Codable, Sendable, Equatable {
    case createIssue(IssueCreate)
    case updateIssue(key: String, patch: IssuePatch)
    case addComment(key: String, body: String)

    /// Writes with the same ordering key run strictly in order. Edits and
    /// comments share their issue's key; each new issue stands alone.
    func orderingKey(entryId: String) -> String {
        switch self {
        case .createIssue: "new:\(entryId)"
        case .updateIssue(let key, _), .addComment(let key, _): "issue:\(key)"
        }
    }

    /// One line for the Outbox screen.
    public var summary: String {
        switch self {
        case .createIssue(let draft): "New issue: \(draft.title)"
        case .updateIssue(let key, let patch):
            if let state = patch.state { "\(key): move to \(state.rawValue.replacingOccurrences(of: "_", with: " "))" }
            else if let priority = patch.priority { "\(key): priority \(priority.rawValue)" }
            else { "\(key): edit" }
        case .addComment(let key, _): "\(key): comment"
        }
    }
}

public enum OutboxStatus: Codable, Sendable, Equatable {
    /// Waiting for its next attempt.
    case pending
    /// Out of attempts or refused by the server. Needs Retry or Discard.
    case failed(reason: String)
}

public struct OutboxEntry: Codable, Sendable, Equatable, Identifiable {
    /// Also the `Idempotency-Key`, so a replay after a lost response is safe.
    public let id: String
    public let workspaceSlug: String
    public let operation: OutboxOperation
    public let orderingKey: String
    public let createdAt: Date
    public var attempts: Int
    public var nextAttemptAt: Date
    public var status: OutboxStatus
    public var lastError: String?
}

/// Retry schedule from the plan: 1 s doubling to a 5 minute cap, 8 attempts.
public struct OutboxPolicy: Sendable {
    public var baseDelay: TimeInterval = 1
    public var maxDelay: TimeInterval = 300
    public var maxAttempts = 8

    public init() {}

    /// Delay after the given number of failed attempts (1-based).
    public func delay(afterAttempt attempt: Int) -> TimeInterval {
        let exponent = Double(max(0, attempt - 1))
        return min(maxDelay, baseDelay * pow(2, exponent))
    }
}

/// How a failed send should be handled.
public enum OutboxFailure: Error, Sendable, Equatable {
    /// Network down, timeout, 409 in flight, 429, 5xx: try again later.
    case retryable(String)
    /// The server said no (validation, state machine, revoked access). Retrying
    /// unchanged will not help; park it with the server's reason.
    case rejected(String)

    /// Classifies an API client error.
    public static func classify(_ error: Error) -> OutboxFailure {
        guard let api = error as? APIClientError else { return .retryable(String(describing: error)) }
        switch api {
        case .transport(let message):
            return .retryable(message)
        case .http(let status, _, let message):
            let reason = message ?? "HTTP \(status)"
            if status == 408 || status == 409 || status == 429 || status >= 500 { return .retryable(reason) }
            return .rejected(reason)
        case .decoding(let message):
            // The write landed; only the response did not parse. Replaying with
            // the same key returns the stored response, so retrying is safe.
            return .retryable(message)
        }
    }
}

/// Sends one entry. The app's implementation calls TrackerClient with
/// `idempotencyKey: entry.id`.
public protocol OutboxSender: Sendable {
    func send(_ entry: OutboxEntry) async throws
}

/// Persistence for the queue. `JSONFileStore` on device, in-memory in tests.
public protocol OutboxStore: Sendable {
    func load() throws -> [OutboxEntry]
    func save(_ entries: [OutboxEntry]) throws
}

public struct DrainResult: Sendable, Equatable {
    public var sent: [String] = []
    public var retrying: [String] = []
    public var failed: [String] = []
}

/// The outbox queue. All state changes are persisted before returning.
public actor Outbox {
    private let store: any OutboxStore
    private let policy: OutboxPolicy
    private let now: @Sendable () -> Date
    private var entries: [OutboxEntry]

    public init(store: any OutboxStore, policy: OutboxPolicy = OutboxPolicy(), now: @escaping @Sendable () -> Date = Date.init) {
        self.store = store
        self.policy = policy
        self.now = now
        self.entries = (try? store.load()) ?? []
    }

    public var all: [OutboxEntry] { entries }
    public var pendingCount: Int { entries.count }
    public var failedCount: Int { entries.filter { if case .failed = $0.status { true } else { false } }.count }

    @discardableResult
    public func enqueue(_ operation: OutboxOperation, workspaceSlug: String, id: String = UUID().uuidString) throws -> OutboxEntry {
        let entry = OutboxEntry(
            id: id,
            workspaceSlug: workspaceSlug,
            operation: operation,
            orderingKey: operation.orderingKey(entryId: id),
            createdAt: now(),
            attempts: 0,
            nextAttemptAt: now(),
            status: .pending,
            lastError: nil
        )
        entries.append(entry)
        try store.save(entries)
        return entry
    }

    /// Entries allowed to send now: the oldest entry of each ordering key, if
    /// it is pending and due. Anything behind a waiting or failed entry waits.
    public func ready() -> [OutboxEntry] {
        var seen = Set<String>()
        var out: [OutboxEntry] = []
        let t = now()
        for entry in entries {
            guard seen.insert(entry.orderingKey).inserted else { continue }
            if entry.status == .pending, entry.nextAttemptAt <= t { out.append(entry) }
        }
        return out
    }

    /// Sends everything ready, repeating until nothing more is ready now.
    public func drain(using sender: any OutboxSender) async -> DrainResult {
        var result = DrainResult()
        var attempted = Set<String>()
        while true {
            let batch = ready().filter { !attempted.contains($0.id) }
            if batch.isEmpty { break }
            for entry in batch {
                attempted.insert(entry.id)
                do {
                    try await sender.send(entry)
                    entries.removeAll { $0.id == entry.id }
                    result.sent.append(entry.id)
                } catch {
                    if record(failure: OutboxFailure.classify(error), for: entry.id) {
                        result.failed.append(entry.id)
                    } else {
                        result.retrying.append(entry.id)
                    }
                }
                try? store.save(entries)
            }
        }
        return result
    }

    /// When the next entry becomes due, for scheduling a timer.
    public func nextWake() -> Date? {
        entries.filter { $0.status == .pending }.map(\.nextAttemptAt).min()
    }

    public func retry(_ id: String) throws {
        guard let i = entries.firstIndex(where: { $0.id == id }) else { return }
        entries[i].attempts = 0
        entries[i].status = .pending
        entries[i].nextAttemptAt = now()
        try store.save(entries)
    }

    public func discard(_ id: String) throws {
        entries.removeAll { $0.id == id }
        try store.save(entries)
    }

    /// Sign-out: nothing queued may outlive the credential.
    public func wipe() throws {
        entries = []
        try store.save(entries)
    }

    /// Returns true when the entry is now parked as failed.
    private func record(failure: OutboxFailure, for id: String) -> Bool {
        guard let i = entries.firstIndex(where: { $0.id == id }) else { return false }
        entries[i].attempts += 1
        switch failure {
        case .rejected(let reason):
            entries[i].lastError = reason
            entries[i].status = .failed(reason: reason)
            return true
        case .retryable(let reason):
            entries[i].lastError = reason
            if entries[i].attempts >= policy.maxAttempts {
                entries[i].status = .failed(reason: "Gave up after \(entries[i].attempts) tries: \(reason)")
                return true
            }
            entries[i].nextAttemptAt = now().addingTimeInterval(policy.delay(afterAttempt: entries[i].attempts))
            return false
        }
    }
}

/// Replays outbox entries through the tracker API, using the entry id as the
/// `Idempotency-Key` so a replay after a lost response applies once.
public struct TrackerOutboxSender: OutboxSender {
    public let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    public func send(_ entry: OutboxEntry) async throws {
        let ws = entry.workspaceSlug
        switch entry.operation {
        case .createIssue(let draft):
            _ = try await client.createIssue(ws: ws, draft, idempotencyKey: entry.id)
        case .updateIssue(let key, let patch):
            _ = try await client.updateIssue(ws: ws, key: key, patch, idempotencyKey: entry.id)
        case .addComment(let key, let body):
            _ = try await client.addComment(ws: ws, key: key, body: body, idempotencyKey: entry.id)
        }
    }
}
