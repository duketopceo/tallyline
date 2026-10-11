import type { ReactNode } from "react";

// Minimal, safe markdown for issue descriptions and comments. It builds React
// nodes (never HTML strings), so there is no injection surface; links are
// limited to http(s) and mailto.
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\))|((?<![*\w])\*[^*\n]+\*(?!\w))|((?<![_\w])_[^_\n]+_(?![_\w]))/g;

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const t = m[0];
    const key = `${keyBase}-${i++}`;
    if (t.startsWith("`")) out.push(<code key={key} className="rounded-xs bg-surface-3 px-1 py-px font-mono text-[12px] text-ink">{t.slice(1, -1)}</code>);
    else if (t.startsWith("**")) out.push(<strong key={key} className="font-semibold text-ink">{t.slice(2, -2)}</strong>);
    else if (t.startsWith("[")) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      out.push(<a key={key} href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2 hover:text-accent-hover">{label}</a>);
    } else out.push(<em key={key}>{t.slice(1, -1)}</em>);
    last = idx + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++;
      blocks.push(<pre key={k++} className="scroll-quiet my-2 overflow-x-auto rounded-sm border border-lining bg-surface-2 p-3 font-mono text-[12px] leading-relaxed text-ink-muted"><code>{code.join("\n")}</code></pre>);
    } else if (/^#{1,3}\s/.test(line)) {
      const level = /^#+/.exec(line)![0].length;
      blocks.push(<p key={k++} className={`mb-1 mt-3 font-semibold text-ink ${level === 1 ? "text-[15px]" : "text-[14px]"}`}>{inline(line.replace(/^#+\s/, ""), `h${k}`)}</p>);
      i++;
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*([-*]|\d+\.)\s/, ""));
      const Tag = ordered ? "ol" : "ul";
      blocks.push(<Tag key={k++} className={`my-1.5 space-y-0.5 pl-5 ${ordered ? "list-decimal" : "list-disc"}`}>{items.map((t, j) => <li key={j}>{inline(t, `li${k}-${j}`)}</li>)}</Tag>);
    } else if (line.startsWith("> ")) {
      const q: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("> ")) q.push(lines[i++]!.slice(2));
      blocks.push(<blockquote key={k++} className="my-1.5 border-l-2 border-lining-strong pl-3 text-ink-subtle">{inline(q.join(" "), `q${k}`)}</blockquote>);
    } else if (line.trim() === "") {
      i++;
    } else {
      const p: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== "" && !/^(```|#{1,3}\s|> |\s*([-*]|\d+\.)\s)/.test(lines[i]!)) p.push(lines[i++]!);
      blocks.push(<p key={k++} className="my-1.5">{p.flatMap((t, j) => [j ? <br key={`b${j}`} /> : null, ...inline(t, `p${k}-${j}`)])}</p>);
    }
  }
  return <div className="max-w-[72ch] text-[14px] leading-relaxed text-ink-muted">{blocks}</div>;
}
