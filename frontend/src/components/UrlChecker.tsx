"use client";

import { FormEvent, useMemo, useState } from "react";
import type { StreamEvent, UrlResult, UrlRow } from "@/lib/types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8001";

function parseUrls(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((u) => u.trim())
    .filter(Boolean);
}

function normalizeUrl(raw: string): string | null {
  let url = raw.trim();
  if (!url) return null;
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
  }
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return null;
    return url;
  } catch {
    return null;
  }
}

/** Match backend row order (normalize invalid URLs, dedupe). */
function prepareRows(urls: string[]): UrlRow[] {
  const rows: UrlRow[] = [];
  const seen = new Set<string>();

  for (const raw of urls) {
    const normalized = normalizeUrl(raw);
    if (normalized === null) {
      rows.push({ url: raw.trim() || "(empty)", result: null });
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    rows.push({ url: normalized, result: null });
  }

  return rows;
}

function statusTone(result: UrlResult): "ok" | "warn" | "fail" {
  if (result.ok) return "ok";
  if (result.accessible) return "warn";
  return "fail";
}

function statusLabel(result: UrlResult): string {
  if (result.ok) return "OK";
  if (result.accessible) return "Reachable";
  return "Unreachable";
}

function rowState(row: UrlRow, loading: boolean): "pending" | "checking" | "ok" | "warn" | "fail" {
  if (row.result) return statusTone(row.result);
  if (loading) return "checking";
  return "pending";
}

const STATUS_SORT_ORDER: Record<ReturnType<typeof rowState>, number> = {
  ok: 0,
  warn: 1,
  fail: 2,
  checking: 3,
  pending: 4,
};

function sortRowsByStatus(rows: UrlRow[], loading: boolean): UrlRow[] {
  return [...rows].sort((a, b) => {
    const toneA = rowState(a, loading);
    const toneB = rowState(b, loading);
    const byTone = STATUS_SORT_ORDER[toneA] - STATUS_SORT_ORDER[toneB];
    if (byTone !== 0) return byTone;

    const codeA = a.result?.status_code ?? Number.POSITIVE_INFINITY;
    const codeB = b.result?.status_code ?? Number.POSITIVE_INFINITY;
    if (codeA !== codeB) return codeA - codeB;

    return a.url.localeCompare(b.url);
  });
}

function toneStyles(tone: "pending" | "checking" | "ok" | "warn" | "fail") {
  switch (tone) {
    case "ok":
      return { color: "var(--ok)", bg: "var(--ok-soft)", label: "OK" };
    case "warn":
      return { color: "var(--warn)", bg: "var(--warn-soft)", label: "Reachable" };
    case "fail":
      return { color: "var(--fail)", bg: "var(--fail-soft)", label: "Failed" };
    case "checking":
      return { color: "var(--accent)", bg: "var(--accent-soft)", label: "Checking" };
    default:
      return { color: "var(--muted)", bg: "transparent", label: "Pending" };
  }
}

async function consumeNdjsonStream(
  response: Response,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) onEvent(JSON.parse(line) as StreamEvent);
    }
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as StreamEvent);
}

export default function UrlChecker() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<UrlRow[]>([]);
  const [total, setTotal] = useState(0);

  const urlCount = useMemo(() => parseUrls(input).length, [input]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const urls = parseUrls(input);
    if (urls.length === 0) {
      setError("Enter at least one URL.");
      setRows([]);
      return;
    }
    if (urls.length > 20000) {
      setError("Maximum 20000 URLs per check.");
      return;
    }

    setLoading(true);
    setError(null);
    const prepared = prepareRows(urls);
    setRows(prepared);
    setTotal(prepared.length);

    try {
      const response = await fetch(`${API_URL}/api/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });

      if (!response.ok) {
        let detail = `API error (${response.status})`;
        try {
          const body = (await response.json()) as { detail?: unknown };
          if (typeof body.detail === "string") {
            detail = body.detail;
          } else if (Array.isArray(body.detail)) {
            detail = body.detail
              .map((item) =>
                typeof item === "object" && item && "msg" in item
                  ? String((item as { msg: unknown }).msg)
                  : JSON.stringify(item),
              )
              .join("; ");
          }
        } catch {
          // keep status-only message
        }
        throw new Error(detail);
      }

      await consumeNdjsonStream(response, (event) => {
        if (event.type === "start") {
          setTotal(event.total);
          return;
        }
        if (event.type === "result") {
          setRows((prev) => {
            const next = [...prev];
            if (event.index >= 0 && event.index < next.length) {
              next[event.index] = { url: event.result.url, result: event.result };
            }
            return next;
          });
          return;
        }
      });
    } catch (err) {
      setRows([]);
      setTotal(0);
      setError(
        err instanceof Error
          ? `${err.message}. Is the Python API running on ${API_URL}?`
          : "Something went wrong.",
      );
    } finally {
      setLoading(false);
    }
  }

  const summary = useMemo(() => {
    if (rows.length === 0) return null;
    const completed = rows.filter((r) => r.result);
    return {
      total: rows.length,
      done: completed.length,
      ok: completed.filter((r) => r.result!.ok).length,
      warn: completed.filter((r) => r.result && !r.result.ok && r.result.accessible).length,
      fail: completed.filter((r) => r.result && !r.result.accessible).length,
    };
  }, [rows]);

  const sortedRows = useMemo(() => sortRowsByStatus(rows, loading), [rows, loading]);

  const showPanel = rows.length > 0;

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1800px] flex-col lg:flex-row">
      <div className="flex flex-col gap-10 px-5 py-14 sm:px-8 sm:py-20 lg:w-[min(420px,32vw)] lg:shrink-0">
        <header className="animate-fade-up space-y-4">
          <p className="font-mono text-xs tracking-[0.28em] text-[var(--accent)] uppercase">
            OSI
          </p>
          <h1 className="max-w-xl text-4xl leading-tight font-semibold tracking-tight text-[var(--ink)] sm:text-5xl">
            URL Checker
          </h1>
          <p className="max-w-lg text-base leading-relaxed text-[var(--muted)] sm:text-lg">
            Paste one or more URLs. Results stream in live as each one is checked.
          </p>
        </header>

        <form
          onSubmit={onSubmit}
          className="animate-fade-up space-y-4"
          style={{ animationDelay: "80ms" }}
        >
          <label htmlFor="urls" className="sr-only">
            URLs
          </label>
          <textarea
            id="urls"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={"https://example.com\nhttps://httpbin.org/status/200\ngoogle.com"}
            rows={8}
            className="w-full resize-y rounded-xl border border-[var(--line)] bg-[var(--bg-input)] px-4 py-3 font-mono text-sm leading-relaxed text-[var(--ink)] outline-none transition-[border-color,box-shadow] placeholder:text-[var(--muted)]/60 focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-soft)]"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="font-mono text-xs text-[var(--muted)]">
              {urlCount} URL{urlCount === 1 ? "" : "s"} · one per line or comma-separated
            </p>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex min-w-36 items-center justify-center rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-[#061210] transition-[transform,opacity,filter] hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? (
                <span className="animate-pulse-soft">Checking…</span>
              ) : (
                "Check URLs"
              )}
            </button>
          </div>
        </form>

        {error && (
          <p
            role="alert"
            className="animate-fade-up rounded-lg border border-[var(--fail)]/30 bg-[var(--fail-soft)] px-4 py-3 text-sm text-[var(--fail)]"
          >
            {error}
          </p>
        )}

        {summary && (
          <section
            className="animate-fade-up space-y-3 lg:hidden"
            style={{ animationDelay: "120ms" }}
            aria-live="polite"
          >
            <LiveSummary summary={summary} loading={loading} total={total} />
          </section>
        )}
      </div>

      {showPanel && (
        <aside
          className="animate-fade-up flex w-full min-w-0 flex-1 flex-col border-t border-[var(--line)] bg-[var(--bg-elevated)]/80 backdrop-blur-sm lg:sticky lg:top-0 lg:h-screen lg:border-t-0 lg:border-l"
          style={{ animationDelay: "100ms" }}
          aria-live="polite"
          aria-label="Live check status"
        >
          <div className="border-b border-[var(--line)] px-4 py-4 sm:px-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-mono text-xs tracking-[0.2em] text-[var(--muted)] uppercase">
                Live status
              </h2>
              {loading && (
                <span className="inline-flex items-center gap-2 font-mono text-xs text-[var(--accent)]">
                  <span className="live-dot h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                  Streaming
                </span>
              )}
            </div>
            {summary && (
              <div className="mt-3 hidden lg:block">
                <LiveSummary summary={summary} loading={loading} total={total} />
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full min-w-[820px] border-collapse text-left">
              <colgroup>
                <col />
                <col className="w-[6.5rem]" />
                <col className="w-[3.5rem]" />
                <col className="w-[9rem]" />
                <col className="w-[7rem]" />
                <col className="w-[11rem]" />
                <col className="w-[4.5rem]" />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-[var(--bg-elevated)] font-mono text-[10px] tracking-wider text-[var(--muted)] uppercase">
                <tr className="border-b border-[var(--line)]">
                  <th className="px-4 py-2.5 font-medium sm:px-5">URL</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">HTTP</th>
                  <th className="px-3 py-2.5 font-medium">IP</th>
                  <th className="px-3 py-2.5 font-medium">Ports</th>
                  <th className="px-3 py-2.5 font-medium">Server</th>
                  <th className="px-3 py-2.5 pr-5 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row) => {
                  const tone = rowState(row, loading);
                  const styles = toneStyles(tone);
                  const result = row.result;

                  return (
                    <tr
                      key={row.url}
                      className="border-b border-[var(--line)]/70 transition-colors duration-300 last:border-b-0"
                      data-state={tone}
                    >
                      <td className="px-4 py-3 align-top sm:px-5">
                        {row.url.startsWith("http://") || row.url.startsWith("https://") ? (
                          <a
                            href={row.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block break-all font-mono text-xs leading-relaxed text-[var(--ink)] underline-offset-2 hover:text-[var(--accent)] hover:underline"
                            title={row.url}
                          >
                            {row.url}
                          </a>
                        ) : (
                          <span className="block break-all font-mono text-xs leading-relaxed text-[var(--ink)]">
                            {row.url}
                          </span>
                        )}
                        {result?.error && (
                          <span
                            className="mt-1 block break-all font-mono text-[10px] leading-snug text-[var(--fail)]"
                            title={result.error}
                          >
                            {result.error}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 align-top whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[10px] font-medium tracking-wide uppercase ${
                            tone === "checking" ? "animate-pulse-soft" : ""
                          }`}
                          style={{ color: styles.color, background: styles.bg }}
                        >
                          {tone === "checking" && (
                            <span className="live-dot h-1 w-1 rounded-full bg-current" />
                          )}
                          {result ? statusLabel(result) : styles.label}
                        </span>
                      </td>
                      <td className="px-3 py-3 align-top font-mono text-xs whitespace-nowrap text-[var(--muted)]">
                        {result?.status_code ?? (result?.error ? "—" : "…")}
                      </td>
                      <td className="px-3 py-3 align-top font-mono text-xs leading-relaxed break-all text-[var(--muted)]">
                        {result?.ip_address ?? (result?.error ? "—" : "…")}
                      </td>
                      <td className="px-3 py-3 align-top font-mono text-xs leading-relaxed text-[var(--muted)]">
                        {result
                          ? result.open_ports && result.open_ports.length > 0
                            ? result.open_ports.join(", ")
                            : "—"
                          : "…"}
                      </td>
                      <td className="px-3 py-3 align-top font-mono text-xs leading-relaxed break-all text-[var(--muted)]">
                        {result ? (result.server ?? "—") : "…"}
                      </td>
                      <td className="px-3 py-3 pr-5 align-top font-mono text-xs whitespace-nowrap text-[var(--muted)]">
                        {result?.response_time_ms != null
                          ? `${result.response_time_ms} ms`
                          : "…"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </aside>
      )}
    </div>
  );
}

function LiveSummary({
  summary,
  loading,
  total,
}: {
  summary: { total: number; done: number; ok: number; warn: number; fail: number };
  loading: boolean;
  total: number;
}) {
  const pct = total > 0 ? Math.round((summary.done / total) * 100) : 0;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-mono text-xs tracking-wide text-[var(--muted)] uppercase">
          {summary.done} / {summary.total} complete
        </p>
        <p className="font-mono text-xs text-[var(--ink)]">{pct}%</p>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-[var(--line)]">
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] tracking-wide text-[var(--muted)] uppercase">
        <span className="text-[var(--ok)]">{summary.ok} ok</span>
        <span className="text-[var(--warn)]">{summary.warn} reachable</span>
        <span className="text-[var(--fail)]">{summary.fail} failed</span>
        {loading && summary.done < summary.total && (
          <span className="text-[var(--accent)]">
            {summary.total - summary.done} in flight
          </span>
        )}
      </div>
    </div>
  );
}
