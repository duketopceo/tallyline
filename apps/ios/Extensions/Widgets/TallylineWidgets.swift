import SwiftUI
import WidgetKit
import TallylineCore
import TallylineDesign

// Widgets read the snapshot file the app writes to the App Group container
// (WidgetSnapshot.sharedStore). They never call the network. Lock Screen
// sizes show counts only; titles stay on the Home Screen.

struct SnapshotEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
}

struct SnapshotProvider: TimelineProvider {
    func placeholder(in context: Context) -> SnapshotEntry {
        SnapshotEntry(date: .now, snapshot: .placeholder)
    }

    func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
        completion(load(preview: context.isPreview))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
        // The app reloads timelines whenever it writes; this is only a backstop.
        completion(Timeline(entries: [load(preview: false)], policy: .after(.now.addingTimeInterval(30 * 60))))
    }

    private func load(preview: Bool) -> SnapshotEntry {
        let stored = try? WidgetSnapshot.sharedStore()?.read()
        return SnapshotEntry(date: .now, snapshot: stored ?? (preview ? .placeholder : nil))
    }
}

@main
struct TallylineWidgetBundle: WidgetBundle {
    var body: some Widget {
        MyIssuesWidget()
        ReviewWidget()
        CycleWidget()
    }
}

// MARK: - My issues

struct MyIssuesWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "app.tallyline.my-issues", provider: SnapshotProvider()) { entry in
            MyIssuesView(entry: entry)
                .containerBackground(Theme.canvas, for: .widget)
                .widgetURL(AppLink.url(.myIssues))
        }
        .configurationDisplayName("My issues")
        .description("Open issues assigned to you, most urgent first.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct MyIssuesView: View {
    let entry: SnapshotEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if let snap = entry.snapshot {
            switch family {
            case .accessoryInline:
                Text("\(snap.myIssueCount) open issues")
            case .accessoryCircular:
                CountBadge(count: snap.myIssueCount, symbol: "list.bullet", label: "My issues")
            case .accessoryRectangular:
                VStack(alignment: .leading) {
                    Text("My issues").font(.headline)
                    Text("\(snap.myIssueCount) open").font(.body)
                }
                .accessibilityElement(children: .combine)
            case .systemSmall:
                VStack(alignment: .leading, spacing: 6) {
                    Header(title: "My issues", count: snap.myIssueCount)
                    ForEach(snap.myIssues.prefix(2)) { IssueRow(row: $0, compact: true) }
                    Spacer(minLength: 0)
                }
            default:
                VStack(alignment: .leading, spacing: 6) {
                    Header(title: "My issues", count: snap.myIssueCount)
                    if snap.myIssues.isEmpty {
                        Text("Nothing assigned to you.").font(.subheadline).foregroundStyle(Theme.inkMuted)
                    }
                    ForEach(snap.myIssues.prefix(4)) { IssueRow(row: $0, compact: false) }
                    Spacer(minLength: 0)
                }
            }
        } else {
            NotLoaded()
        }
    }
}

// MARK: - Review

struct ReviewWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "app.tallyline.review", provider: SnapshotProvider()) { entry in
            ReviewView(entry: entry)
                .containerBackground(Theme.canvas, for: .widget)
                .widgetURL(AppLink.url(.review))
        }
        .configurationDisplayName("Needs your review")
        .description("Agent work waiting for you to approve.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryInline])
    }
}

struct ReviewView: View {
    let entry: SnapshotEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if let snap = entry.snapshot {
            switch family {
            case .accessoryInline:
                Text("\(snap.reviewCount) to review")
            case .accessoryCircular:
                CountBadge(count: snap.reviewCount, symbol: "checkmark.circle", label: "Needs your review")
            default:
                VStack(alignment: .leading, spacing: 4) {
                    Text("Needs your review").font(.caption).foregroundStyle(Theme.inkMuted)
                    Text("\(snap.reviewCount)")
                        .font(.system(.largeTitle, design: .rounded).weight(.semibold))
                        .foregroundStyle(snap.reviewCount > 0 ? Theme.accent : Theme.ink)
                    Spacer(minLength: 0)
                    Text(snap.reviewCount == 0 ? "All clear" : "Tap to review").font(.caption2).foregroundStyle(Theme.inkSubtle)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
            }
        } else {
            NotLoaded()
        }
    }
}

// MARK: - Cycle

struct CycleWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "app.tallyline.cycle", provider: SnapshotProvider()) { entry in
            CycleView(entry: entry)
                .containerBackground(Theme.canvas, for: .widget)
                .widgetURL(AppLink.url(.myIssues))
        }
        .configurationDisplayName("Cycle progress")
        .description("How much of the current cycle is done.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular])
    }
}

struct CycleView: View {
    let entry: SnapshotEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if let snap = entry.snapshot {
            if let cycle = snap.cycle {
                switch family {
                case .accessoryCircular:
                    Gauge(value: cycle.fraction) {
                        Text("Cycle")
                    } currentValueLabel: {
                        Text("\(Int((cycle.fraction * 100).rounded()))%")
                    }
                    .gaugeStyle(.accessoryCircularCapacity)
                    .accessibilityLabel("\(cycle.name), \(cycle.done) of \(cycle.total) done")
                case .accessoryRectangular:
                    VStack(alignment: .leading) {
                        Text(cycle.name).font(.headline)
                        Text("\(cycle.done) of \(cycle.total) done")
                    }
                    .accessibilityElement(children: .combine)
                default:
                    VStack(alignment: .leading, spacing: 6) {
                        Text(cycle.name).font(.caption).foregroundStyle(Theme.inkMuted).lineLimit(1)
                        Gauge(value: cycle.fraction) { EmptyView() }
                            .gaugeStyle(.linearCapacity)
                            .tint(Theme.accent)
                        Text("\(cycle.done) of \(cycle.total) done").font(.headline)
                        Spacer(minLength: 0)
                        if let end = cycle.endsAt {
                            Text("Ends \(end, format: .dateTime.month().day())").font(.caption2).foregroundStyle(Theme.inkSubtle)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            } else {
                Text("No active cycle").font(.caption).foregroundStyle(Theme.inkMuted)
            }
        } else {
            NotLoaded()
        }
    }
}

// MARK: - Shared pieces

struct Header: View {
    let title: String
    let count: Int

    var body: some View {
        HStack {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(Theme.inkMuted)
            Spacer()
            Text("\(count)").font(.caption.weight(.semibold)).foregroundStyle(Theme.accent)
        }
        .accessibilityElement(children: .combine)
    }
}

struct IssueRow: View {
    let row: WidgetSnapshot.Row
    let compact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            if !compact {
                Text(row.key).font(.caption2.monospaced()).foregroundStyle(Theme.inkSubtle)
            }
            Text(row.title).font(compact ? .caption : .subheadline).foregroundStyle(Theme.ink).lineLimit(compact ? 2 : 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(row.key), \(row.title), \(row.priority.rawValue) priority")
    }
}

struct CountBadge: View {
    let count: Int
    let symbol: String
    let label: String

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Image(systemName: symbol).font(.caption2)
                Text("\(count)").font(.headline)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label): \(count)")
    }
}

struct NotLoaded: View {
    var body: some View {
        Text("Open Tallyline to load").font(.caption).foregroundStyle(Theme.inkMuted)
    }
}
