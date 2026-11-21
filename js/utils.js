/* ==========================================================================
   utils.js — Local calendar date math, DST-safe midnight splitting, formatting
   ========================================================================== */
(function (global) {
  'use strict';

  function pad2(n) {
    return String(Math.floor(Math.abs(n))).padStart(2, '0');
  }

  function uid(prefix = 'id') {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
    }
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Returns local YYYY-MM-DD for a timestamp (ms).
   */
  function getLocalDateKey(ts = Date.now()) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  /**
   * Parses YYYY-MM-DD into local Date at 00:00:00.000.
   */
  function parseLocalDateKey(dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  }

  /**
   * Returns exact local calendar day boundaries (DST-safe: may be 23h, 24h, or 25h).
   */
  function getLocalDayBounds(dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    const startMs = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
    const endMs = new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime();
    return {
      dateKey,
      startMs,
      endMs,
      durationMs: endMs - startMs
    };
  }

  function addDaysToDateKey(dateKey, deltaDays) {
    const [y, m, d] = dateKey.split('-').map(Number);
    const next = new Date(y, m - 1, d + deltaDays, 0, 0, 0, 0);
    return getLocalDateKey(next.getTime());
  }

  /**
   * Splits an interval [startMs, endMs] across local calendar midnight boundaries.
   * Guarantees:
   * - Sum of slice durations === (endMs - startMs)
   * - Zero overlap, zero lost milliseconds, DST-safe.
   */
  function splitIntervalByLocalMidnight(startMs, endMs) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return [];
    }
    const slices = [];
    let cursor = startMs;
    while (cursor < endMs) {
      const dateKey = getLocalDateKey(cursor);
      const { endMs: dayEndMs } = getLocalDayBounds(dateKey);
      const sliceEnd = Math.min(endMs, dayEndMs);
      if (sliceEnd > cursor) {
        slices.push({
          dateKey,
          startMs: cursor,
          endMs: sliceEnd,
          durationMs: sliceEnd - cursor
        });
      }
      if (sliceEnd <= cursor) break;
      cursor = sliceEnd;
    }
    return slices;
  }

  function formatHMS(ms) {
    const clamped = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(clamped / 3600);
    const m = Math.floor((clamped % 3600) / 60);
    const s = clamped % 60;
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  }

  function formatCountdown(ms) {
    const clamped = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(clamped / 3600);
    const m = Math.floor((clamped % 3600) / 60);
    const s = clamped % 60;
    if (h > 0) return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
    return `${pad2(m)}:${pad2(s)}`;
  }

  function formatDurationShort(ms) {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    if (totalSec < 60) return `${totalSec}s`;
    const totalMin = Math.floor(totalSec / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  }

  function formatClockTime(ts) {
    if (!Number.isFinite(ts)) return '--:--';
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function formatClockTimeWithSec(ts) {
    if (!Number.isFinite(ts)) return '--:--:--';
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function formatDateHuman(dateKey) {
    const d = parseLocalDateKey(dateKey);
    return d.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }

  function timeInputToMs(dateKey, hhmm) {
    if (!hhmm || !hhmm.includes(':')) return null;
    const [y, m, d] = dateKey.split('-').map(Number);
    const [hh, mm] = hhmm.split(':').map(Number);
    return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  global.TimeUtils = {
    pad2,
    uid,
    getLocalDateKey,
    parseLocalDateKey,
    getLocalDayBounds,
    addDaysToDateKey,
    splitIntervalByLocalMidnight,
    formatHMS,
    formatCountdown,
    formatDurationShort,
    formatClockTime,
    formatClockTimeWithSec,
    formatDateHuman,
    timeInputToMs,
    escapeHtml
  };
})(typeof window !== 'undefined' ? window : globalThis);
