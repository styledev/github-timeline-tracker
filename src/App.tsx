import { useMemo, useState } from "react";
import { aggregate, summarizeRange } from "./aggregate";
import { DayTimeline } from "./components/DayTimeline";
import { RangeSummary } from "./components/RangeSummary";
import { fetchCommits, getRateLimit, type FetchProgress } from "./github";
import type { Commit } from "./types";
import "./App.css";

const TOKEN_KEY = "gtt.token";
const ALL_BRANCHES_KEY = "gtt.allBranches";

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(date.getDate()).padStart(2, "0")}`;
}

function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 6);
  return { from: isoDate(from), to: isoDate(to) };
}

export default function App() {
  const initialRange = useMemo(() => defaultRange(), []);
  const [token, setToken] = useState(
    () => localStorage.getItem(TOKEN_KEY) ?? "",
  );
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [allBranches, setAllBranches] = useState(
    () => localStorage.getItem(ALL_BRANCHES_KEY) === "true",
  );
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<FetchProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const days = useMemo(() => (commits ? aggregate(commits) : []), [commits]);
  const summary = useMemo(() => summarizeRange(days), [days]);
  const rateLimit = getRateLimit();

  function saveToken(value: string) {
    setToken(value);
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  }

  function toggleAllBranches(value: boolean) {
    setAllBranches(value);
    localStorage.setItem(ALL_BRANCHES_KEY, String(value));
  }

  async function load() {
    if (!token) {
      setError("A GitHub personal access token is required.");
      return;
    }
    const [fy, fm, fd] = from.split("-").map(Number);
    const [ty, tm, td] = to.split("-").map(Number);
    const fromDate = new Date(fy, fm - 1, fd, 0, 0, 0, 0);
    const toDate = new Date(ty, tm - 1, td, 23, 59, 59, 999);
    if (fromDate > toDate) {
      setError("The start date must be on or before the end date.");
      return;
    }

    setLoading(true);
    setError(null);
    setProgress(null);
    try {
      const result = await fetchCommits(
        token,
        fromDate,
        toDate,
        setProgress,
        allBranches,
      );
      setCommits(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCommits(null);
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>GitHub Timeline Tracker</h1>
        <p className="subtitle">
          Commits per repo per day, shown in your local timezone (
          {Intl.DateTimeFormat().resolvedOptions().timeZone}).
        </p>

        <div className="controls">
          <label>
            <span>Personal access token</span>
            <input
              type="password"
              value={token}
              placeholder="ghp_..."
              onChange={(e) => saveToken(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            <span>From</span>
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            <span>To</span>
            <input
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <button onClick={load} disabled={loading}>
            {loading ? "Loading…" : "Load commits"}
          </button>
        </div>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={allBranches}
            onChange={(e) => toggleAllBranches(e.target.checked)}
          />
          <span>
            Include all branches{" "}
            <em>
              — catches unmerged work; slower and uses more API quota
            </em>
          </span>
        </label>

        {rateLimit && (
          <p className="rate-limit">
            API quota: {rateLimit.remaining}/{rateLimit.limit} remaining, resets{" "}
            {new Date(rateLimit.resetAt).toLocaleTimeString()}
          </p>
        )}
      </header>

      {error && <div className="banner error">{error}</div>}

      {loading && (
        <div className="banner info">
          {progress && progress.total > 0
            ? `Fetching commits… ${progress.completed}/${progress.total}${
                progress.current ? ` (${progress.current})` : ""
              }${
                progress.usedFallback
                  ? " — scanning affiliated repos (contribution data unavailable for this token)"
                  : ""
              }`
            : "Finding repositories you committed to…"}
        </div>
      )}

      {!loading && commits !== null && days.length === 0 && (
        <div className="banner info">
          No commits found in this date range.
          {!allBranches && (
            <>
              {" "}
              If you committed to a branch that hasn't been merged yet, enable{" "}
              <strong>Include all branches</strong> and load again.
            </>
          )}
        </div>
      )}

      {days.length > 0 && (
        <main>
          <RangeSummary stats={summary} />
          {days.map((day) => (
            <DayTimeline key={day.day} day={day} />
          ))}
        </main>
      )}

      {commits === null && !loading && !error && (
        <div className="banner info">
          Enter a token with <code>repo</code> and <code>read:user</code> scope,
          pick a date range, and load your commits.
        </div>
      )}
    </div>
  );
}
