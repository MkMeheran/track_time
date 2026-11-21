/* ==========================================================================
   master-timer.js — Independent Calendar-Day Master Timer Engine
   ========================================================================== */
(function (global) {
  'use strict';

  const U = global.TimeUtils;

  class MasterTimerEngine {
    constructor(storage) {
      this.storage = storage;
      this.daysMap = new Map(); // dateKey -> masterDay record
    }

    async init() {
      const all = await this.storage.getAll('masterDays');
      this.daysMap.clear();
      for (const rec of all) {
        this.daysMap.set(rec.dateKey, rec);
      }
    }

    getDayRecord(dateKey) {
      return this.daysMap.get(dateKey) || null;
    }

    /**
     * Starts Master Timer for the calendar day of `ts`.
     * Strictly idempotent: NEVER starts twice for the same day.
     */
    async startForTimestamp(ts = Date.now(), autoStarted = false) {
      const dateKey = U.getLocalDateKey(ts);
      const existing = this.daysMap.get(dateKey);
      if (existing) {
        return { record: existing, alreadyRunning: true };
      }
      const bounds = U.getLocalDayBounds(dateKey);
      const record = {
        dateKey,
        startedAtMs: Math.max(bounds.startMs, Math.min(ts, bounds.endMs)),
        dayStartMs: bounds.startMs,
        dayEndMs: bounds.endMs,
        finalized: false,
        finalizedAtMs: null,
        autoStarted: Boolean(autoStarted)
      };
      await this.storage.put('masterDays', record);
      this.daysMap.set(dateKey, record);
      return { record, alreadyRunning: false };
    }

    /**
     * Finalizes any past unfinalized master day whose calendar boundary has passed.
     */
    async finalizePastDays(nowMs = Date.now()) {
      const todayKey = U.getLocalDateKey(nowMs);
      const finalizedKeys = [];
      for (const [dk, rec] of this.daysMap.entries()) {
        if (dk < todayKey && !rec.finalized) {
          rec.finalized = true;
          rec.finalizedAtMs = rec.dayEndMs;
          await this.storage.put('masterDays', rec);
          finalizedKeys.push(dk);
        }
      }
      return finalizedKeys;
    }

    /**
     * Returns live status for today's Master Timer.
     */
    getTodaySnapshot(nowMs = Date.now()) {
      const todayKey = U.getLocalDateKey(nowMs);
      const bounds = U.getLocalDayBounds(todayKey);
      const rec = this.daysMap.get(todayKey) || null;
      const remainingInDayMs = Math.max(0, bounds.endMs - nowMs);
      const elapsedDayMs = Math.max(0, nowMs - bounds.startMs);

      if (!rec) {
        return {
          dateKey: todayKey,
          isRunning: false,
          startedAtMs: null,
          elapsedSinceStartMs: 0,
          elapsedDayMs,
          remainingInDayMs,
          dayDurationMs: bounds.durationMs,
          dayProgressPct: Math.min(100, (elapsedDayMs / bounds.durationMs) * 100)
        };
      }

      const elapsedSinceStartMs = Math.max(0, Math.min(nowMs, bounds.endMs) - rec.startedAtMs);
      return {
        dateKey: todayKey,
        isRunning: true,
        autoStarted: rec.autoStarted,
        startedAtMs: rec.startedAtMs,
        elapsedSinceStartMs,
        elapsedDayMs,
        remainingInDayMs,
        dayDurationMs: bounds.durationMs,
        dayProgressPct: Math.min(100, (elapsedDayMs / bounds.durationMs) * 100)
      };
    }
  }

  global.MasterTimerEngine = MasterTimerEngine;
})(typeof window !== 'undefined' ? window : globalThis);
