import type { DayStats } from "../types";
import {
  dayFraction,
  formatDayLabel,
  formatDuration,
  formatTime,
  repoColor,
} from "../aggregate";

const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24];

function HourAxis() {
  return (
    <div className="hour-axis">
      {HOUR_TICKS.map((hour) => (
        <span
          key={hour}
          className="hour-tick"
          style={{ left: `${(hour / 24) * 100}%` }}
        >
          {hour === 24 ? "24" : String(hour).padStart(2, "0")}
        </span>
      ))}
    </div>
  );
}

export function DayTimeline({ day }: { day: DayStats }) {
  return (
    <section className="day">
      <header className="day-header">
        <h2>{formatDayLabel(day.day)}</h2>
        <dl className="day-totals">
          <div>
            <dt>Commits</dt>
            <dd>{day.totalCommits}</dd>
          </div>
          <div>
            <dt>Repos</dt>
            <dd>{day.repoCount}</dd>
          </div>
          <div>
            <dt>First → last</dt>
            <dd>
              {formatTime(day.firstAt)} – {formatTime(day.lastAt)}
            </dd>
          </div>
          <div>
            <dt title="Wall-clock time from the day's first commit to its last">
              Total span
            </dt>
            <dd>{formatDuration(day.totalSpanMs)}</dd>
          </div>
          <div>
            <dt title="Sum of each repo's own first-to-last span">
              Summed span
            </dt>
            <dd>{formatDuration(day.summedSpanMs)}</dd>
          </div>
        </dl>
      </header>

      <HourAxis />

      <div className="rows">
        {day.repos.map((repo) => {
          const left = dayFraction(repo.firstAt) * 100;
          const width = Math.max(dayFraction(repo.lastAt) * 100 - left, 0.6);
          const color = repoColor(repo.repo);
          return (
            <div className="row" key={repo.repo}>
              <div className="row-label" title={repo.repo}>
                <span className="dot" style={{ background: color }} />
                {repo.repo}
              </div>
              <div className="track">
                {HOUR_TICKS.map((hour) => (
                  <span
                    key={hour}
                    className="gridline"
                    style={{ left: `${(hour / 24) * 100}%` }}
                  />
                ))}
                <div
                  className="bar"
                  style={{
                    left: `${left}%`,
                    width: `${width}%`,
                    background: color,
                  }}
                  title={`${repo.commitCount} commit(s), ${formatTime(
                    repo.firstAt,
                  )} – ${formatTime(repo.lastAt)}`}
                />
              </div>
              <div className="row-stats">
                <span className="badge">{repo.commitCount}</span>
                <span className="span">{formatDuration(repo.spanMs)}</span>
                <span className="times">
                  {formatTime(repo.firstAt)} – {formatTime(repo.lastAt)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
