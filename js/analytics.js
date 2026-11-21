/* ==========================================================================
   analytics.js — Non-overlapping interval merger, wasted time & history stats
   ========================================================================== */
(function (global) {
  'use strict';

  const U = global.TimeUtils;

  /**
   * Merges overlapping [startMs, endMs] intervals so time is NEVER double-counted.
   */
  function mergeIntervals(intervals) {
    if (!intervals || intervals.length === 0) return [];
    const valid = intervals
      .filter((iv) => Number.isFinite(iv.startMs) && Number.isFinite(iv.endMs) && iv.endMs > iv.startMs)
      .map((iv) => ({ startMs: iv.startMs, endMs: iv.endMs }))
      .sort((a, b) => a.startMs - b.startMs);

    if (valid.length === 0) return [];
    const merged = [valid[0]];
    for (let i = 1; i < valid.length; i++) {
      const curr = valid[i];
      const last = merged[merged.length - 1];
      if (curr.startMs <= last.endMs) {
        last.endMs = Math.max(last.endMs, curr.endMs);
      } else {
        merged.push(curr);
      }
    }
    return merged;
  }

  function sumIntervals(intervals) {
    return mergeIntervals(intervals).reduce((acc, iv) => acc + (iv.endMs - iv.startMs), 0);
  }

  /**
   * Computes unallocated gaps inside [windowStartMs, windowEndMs] given merged allocated intervals.
   */
  function computeUnallocatedGaps(allocatedIntervals, windowStartMs, windowEndMs) {
    if (windowEndMs <= windowStartMs) return [];
    const clamped = allocatedIntervals
      .map((iv) => ({
        startMs: Math.max(iv.startMs, windowStartMs),
        endMs: Math.min(iv.endMs, windowEndMs)
      }))
      .filter((iv) => iv.endMs > iv.startMs);

    const merged = mergeIntervals(clamped);
    const gaps = [];
    let cursor = windowStartMs;
    for (const iv of merged) {
      if (iv.startMs > cursor) {
        gaps.push({
          startMs: cursor,
          endMs: iv.startMs,
          durationMs: iv.startMs - cursor
        });
      }
      cursor = Math.max(cursor, iv.endMs);
    }
    if (cursor < windowEndMs) {
      gaps.push({
        startMs: cursor,
        endMs: windowEndMs,
        durationMs: windowEndMs - cursor
      });
    }
    return gaps;
  }

  /**
   * Computes full daily analytics for a given local dateKey.
   * Rules:
   * - Wasted time = ONLY unallocated time (Break and Other labeled activities are ALLOCATED).
   * - Overlapping intervals are merged and never double-counted.
   * - Partially stopped sessions contribute actual elapsed time, NOT completed count.
   * - Sleep is kept separate unless includeSleep === true.
   */
  function computeDailyAnalytics({
    dateKey,
    sessions = [],
    activeSessionLiveSlice = null,
    masterDay = null,
    sleepRecords = [],
    nowMs = Date.now(),
    includeSleep = false
  }) {
    const bounds = U.getLocalDayBounds(dateKey);
    const todayKey = U.getLocalDateKey(nowMs);
    const isToday = dateKey === todayKey;
    const isFuture = dateKey > todayKey;

    // Collect sessions for this day, clamped to local day bounds
    const daySessions = sessions
      .filter((s) => s.dateKey === dateKey)
      .map((s) => ({
        ...s,
        startMs: Math.max(s.startMs, bounds.startMs),
        endMs: Math.min(s.endMs, bounds.endMs)
      }))
      .filter((s) => s.endMs > s.startMs)
      .sort((a, b) => a.startMs - b.startMs);

    // Include live running session slice (if any) for real-time display
    const allIntervals = [...daySessions];
    if (activeSessionLiveSlice && activeSessionLiveSlice.dateKey === dateKey && activeSessionLiveSlice.endMs > activeSessionLiveSlice.startMs) {
      allIntervals.push({
        ...activeSessionLiveSlice,
        isLive: true
      });
    }

    // Optional sleep inclusion in custom analytics view
    const daySleep = sleepRecords.filter((r) => r.dateKey === dateKey);
    const sleepTotalMs = daySleep.reduce((acc, r) => acc + Math.max(0, r.durationMs || 0), 0);
    if (includeSleep) {
      for (const sr of daySleep) {
        const slices = U.splitIntervalByLocalMidnight(sr.sleepStartMs, sr.wakeUpMs);
        for (const sl of slices) {
          if (sl.dateKey === dateKey) {
            allIntervals.push({
              id: sr.id,
              dateKey,
              labelId: '__sleep__',
              labelName: 'Sleep',
              category: 'other',
              color: '#802C62',
              startMs: sl.startMs,
              endMs: sl.endMs,
              actualMs: sl.durationMs,
              configuredMs: sl.durationMs,
              completed: true,
              triggerMode: 'sleep'
            });
          }
        }
      }
    }

    const studyIntervals = allIntervals.filter((s) => s.category === 'study');
    const breakIntervals = allIntervals.filter((s) => s.category === 'break');
    const otherIntervals = allIntervals.filter((s) => s.category !== 'study' && s.category !== 'break');

    const studyMs = sumIntervals(studyIntervals);
    const breakMs = sumIntervals(breakIntervals);
    const otherMs = sumIntervals(otherIntervals);
    const totalAllocatedMs = sumIntervals(allIntervals);

    // Per-label non-overlapping totals
    const byLabelMap = new Map();
    for (const iv of allIntervals) {
      const key = iv.labelId || iv.labelName;
      if (!byLabelMap.has(key)) {
        byLabelMap.set(key, {
          labelId: iv.labelId,
          labelName: iv.labelName,
          category: iv.category,
          color: iv.color || '#802C62',
          intervals: [],
          blockCount: 0,
          completedCount: 0
        });
      }
      const entry = byLabelMap.get(key);
      entry.intervals.push(iv);
      if (!iv.isLive) {
        entry.blockCount += 1;
        if (iv.completed) entry.completedCount += 1;
      }
    }
    const byLabel = Array.from(byLabelMap.values())
      .map((e) => ({
        labelId: e.labelId,
        labelName: e.labelName,
        category: e.category,
        color: e.color,
        totalMs: sumIntervals(e.intervals),
        blockCount: e.blockCount,
        completedCount: e.completedCount
      }))
      .sort((a, b) => b.totalMs - a.totalMs);

    // Master window & unallocated calculation
    const trackingEndMs = isToday ? Math.min(nowMs, bounds.endMs) : (isFuture ? bounds.startMs : bounds.endMs);
    const masterStartMs = masterDay && Number.isFinite(masterDay.startedAtMs)
      ? Math.max(bounds.startMs, Math.min(masterDay.startedAtMs, trackingEndMs))
      : null;

    const elapsedSinceMasterMs = masterStartMs !== null ? Math.max(0, trackingEndMs - masterStartMs) : 0;
    const allocatedSinceMasterMs = masterStartMs !== null
      ? sumIntervals(allIntervals.map((iv) => ({
          startMs: Math.max(iv.startMs, masterStartMs),
          endMs: Math.min(iv.endMs, trackingEndMs)
        })))
      : 0;

    // Unallocated elapsed (since Master start) AND full calendar day unallocated (24h - allocated)
    const unallocatedSinceMasterMs = Math.max(0, elapsedSinceMasterMs - allocatedSinceMasterMs);
    const fullDayUnallocatedMs = Math.max(0, bounds.durationMs - totalAllocatedMs);
    const remainingInDayMs = isToday ? Math.max(0, bounds.endMs - nowMs) : 0;

    // Unallocated gaps for manual correction (within Master window if started, else within elapsed day)
    const gapWindowStart = masterStartMs !== null ? masterStartMs : bounds.startMs;
    const unallocatedGaps = computeUnallocatedGaps(allIntervals, gapWindowStart, trackingEndMs)
      .filter((g) => g.durationMs >= 60 * 1000); // Show gaps >= 1 minute for clean manual assignment

    // Session counts (ONLY completed === true counts as completed)
    const completedSessions = daySessions.filter((s) => s.completed === true).length;
    const completedBreaks = daySessions.filter((s) => s.category === 'break' && s.completed === true).length;
    const studyBlocks = daySessions.filter((s) => s.category === 'study').length;
    const breakBlocks = daySessions.filter((s) => s.category === 'break').length;
    const otherBlocks = daySessions.filter((s) => s.category !== 'study' && s.category !== 'break').length;

    return {
      dateKey,
      bounds,
      isToday,
      masterStarted: masterStartMs !== null,
      masterStartMs,
      trackingEndMs,
      elapsedSinceMasterMs,
      remainingInDayMs,
      studyMs,
      breakMs,
      otherMs,
      totalAllocatedMs,
      unallocatedSinceMasterMs,
      fullDayUnallocatedMs,
      unallocatedGaps,
      byLabel,
      sessions: daySessions,
      allIntervals,
      completedSessions,
      completedBreaks,
      studyBlocks,
      breakBlocks,
      otherBlocks,
      sleepTotalMs,
      sleepRecords: daySleep
    };
  }

  /**
   * Computes rolling 7-day weekly summary ending on endDateKey.
   */
  function computeWeeklySummary(endDateKey, sessions, masterDaysMap, sleepRecords, nowMs, includeSleep = false) {
    const days = [];
    let totalStudyMs = 0;
    let totalBreakMs = 0;
    let totalOtherMs = 0;
    let totalAllocatedMs = 0;
    let totalUnallocatedMs = 0;
    let completedSessions = 0;
    let completedBreaks = 0;
    let activeDaysCount = 0;

    for (let i = 6; i >= 0; i--) {
      const dk = U.addDaysToDateKey(endDateKey, -i);
      const dayStats = computeDailyAnalytics({
        dateKey: dk,
        sessions,
        masterDay: masterDaysMap.get(dk) || null,
        sleepRecords,
        nowMs,
        includeSleep
      });
      days.push(dayStats);
      totalStudyMs += dayStats.studyMs;
      totalBreakMs += dayStats.breakMs;
      totalOtherMs += dayStats.otherMs;
      totalAllocatedMs += dayStats.totalAllocatedMs;
      totalUnallocatedMs += dayStats.masterStarted
        ? dayStats.unallocatedSinceMasterMs
        : (dayStats.totalAllocatedMs > 0 ? dayStats.fullDayUnallocatedMs : 0);
      completedSessions += dayStats.completedSessions;
      completedBreaks += dayStats.completedBreaks;
      if (dayStats.totalAllocatedMs > 0 || dayStats.masterStarted) {
        activeDaysCount += 1;
      }
    }

    const avgDailyStudyMs = activeDaysCount > 0 ? Math.round(totalStudyMs / activeDaysCount) : 0;

    return {
      days,
      totalStudyMs,
      avgDailyStudyMs,
      totalBreakMs,
      totalOtherMs,
      totalAllocatedMs,
      totalUnallocatedMs,
      completedSessions,
      completedBreaks,
      activeDaysCount
    };
  }

  global.AnalyticsEngine = {
    mergeIntervals,
    sumIntervals,
    computeUnallocatedGaps,
    computeDailyAnalytics,
    computeWeeklySummary
  };
})(typeof window !== 'undefined' ? window : globalThis);
