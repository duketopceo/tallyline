import Foundation

/// A small Codable value persisted as one JSON file, written atomically.
///
/// The plan named SwiftData (GRDB as fallback). A JSON file was chosen instead:
/// the outbox and issue cache are small, the logic stays testable on Linux,
/// and there is no schema migration to manage. Revisit if the cache grows past
/// a few thousand issues.
public final class JSONFileStore<Value: Codable & Sendable>: @unchecked Sendable {
    private let url: URL
    private let lock = NSLock()

    public init(url: URL) {
        self.url = url
    }

    /// Store under Application Support (or the App Group container when given).
    public static func standard(named name: String, in directory: URL? = nil) -> JSONFileStore<Value> {
        let base = directory
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return JSONFileStore(url: base.appendingPathComponent("Tallyline", isDirectory: true).appendingPathComponent("\(name).json"))
    }

    public func read() throws -> Value? {
        lock.lock(); defer { lock.unlock() }
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try Self.decoder.decode(Value.self, from: Data(contentsOf: url))
    }

    public func write(_ value: Value) throws {
        lock.lock(); defer { lock.unlock() }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Self.encoder.encode(value).write(to: url, options: [.atomic])
    }

    public func delete() throws {
        lock.lock(); defer { lock.unlock() }
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }

    private static var encoder: JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.sortedKeys]
        return e
    }

    private static var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}

extension JSONFileStore: OutboxStore where Value == [OutboxEntry] {
    public func load() throws -> [OutboxEntry] { try read() ?? [] }
    public func save(_ entries: [OutboxEntry]) throws { try write(entries) }
}

/// Local copy of a workspace's issues, read first and revalidated by delta.
public struct IssueCacheSnapshot: Codable, Sendable, Equatable {
    public var workspaceSlug: String
    public var issues: [Issue]
    /// Server-side high-water mark for `updatedSince`.
    public var syncedAt: Date?

    public init(workspaceSlug: String, issues: [Issue] = [], syncedAt: Date? = nil) {
        self.workspaceSlug = workspaceSlug
        self.issues = issues
        self.syncedAt = syncedAt
    }

    /// Applies a delta: newer `updatedAt` wins per id; new ids are added.
    public mutating func merge(_ delta: [Issue], syncedAt: Date) {
        var byId = Dictionary(uniqueKeysWithValues: issues.map { ($0.id, $0) })
        for issue in delta {
            if let current = byId[issue.id], current.updatedAt > issue.updatedAt { continue }
            byId[issue.id] = issue
        }
        issues = byId.values.sorted { $0.updatedAt > $1.updatedAt }
        self.syncedAt = syncedAt
    }

    public func issues(in state: IssueState?) -> [Issue] {
        guard let state else { return issues }
        return issues.filter { $0.state == state }
    }
}
