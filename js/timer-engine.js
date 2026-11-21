/* ==========================================================================
   timer-engine.js — Pure Timestamp-Based Session Timer, Midnight Rollover &
                     State Recovery Engine (Zero reliance on setInterval counts)
   ========================================================================== */
(function (global) {
  'use strict';

  const U = global.TimeUtils;

  class TimerEngine {
    constructor({ storage, masterTimer, workflowEngine, onEvent }) {
      this.storage = storage;
      this.masterTimer = masterTimer;
      this.workflowEngine = workflowEngine;
      this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};

      this.labels = new Map();
      this.sessions = [];
      this.runtime = {
        id: 'current',
        activeSession: null,
        activeWorkflow: null,
        lastProcessedMs: Date.now(),
        pendingCompletion: null
      };
      this._reconciling = false;
    }

    async init(nowMs = Date.now()) {
      await this.reloadLabels();
      this.sessions = await this.storage.getAll('sessions');
      const savedRuntime = await this.storage.get('runtimeState', 'current');
      if (savedRuntime) {
        this.runtime = savedRuntime;
      }
      // Recover state across browser closure / screen lock / midnight
      await this.reconcile(nowMs);
    }

    async reloadLabels() {
      const all = await this.storage.getAll('labels');
      this.labels.clear();
      for (const lbl of all) {
        this.labels.set(lbl.id, lbl);
      }
    }

    getLabels(includeArchived = false) {
      return Array.from(this.labels.values())
        .filter((l) => includeArchived || !l.archived)
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    }

    getLabel(id) {
      return this.labels.get(id) || null;
    }

    async saveLabel(labelData) {
      const existing = labelData.id ? this.labels.get(labelData.id) : null;
      const rec = {
        id: labelData.id || U.uid('lbl'),
        name: (labelData.name || 'Untitled').trim(),
        durationMin: Math.max(1, Number(labelData.durationMin) || 25),
        description: (labelData.description || '').trim(),
        category: labelData.category || 'other', // 'study' | 'break' | 'other'
        color: labelData.color || '#802C62',
        icon: labelData.icon || 'clock',
        inAutoSequence: labelData.inAutoSequence !== false,
        archived: Boolean(labelData.archived),
        createdAt: existing ? existing.createdAt : Date.now()
      };
      await this.storage.put('labels', rec);
      this.labels.set(rec.id, rec);
      return rec;
    }

    async deleteLabel(id) {
      await this.storage.delete('labels', id);
      this.labels.delete(id);
    }

    async _persistRuntime() {
      await this.storage.put('runtimeState', this.runtime);
    }

    async _recordSessionSlices(baseMeta, startMs, endMs, { completed, triggerMode }) {
      const slices = U.splitIntervalByLocalMidnight(startMs, endMs);
      const created = [];
      for (let i = 0; i < slices.length; i++) {
        const sl = slices[i];
        const isLastSlice = i === slices.length - 1;
        const rec = {
          id: U.uid('sess'),
          sessionGroupId: baseMeta.sessionGroupId,
          dateKey: sl.dateKey,
          labelId: baseMeta.labelId,
          labelName: baseMeta.labelName,
          category: baseMeta.category,
          color: baseMeta.color,
          startMs: sl.startMs,
          endMs: sl.endMs,
          configuredMs: baseMeta.configuredMs,
          actualMs: sl.durationMs,
          // Only mark completed on the final slice if the full configured duration finished
          completed: Boolean(completed && isLastSlice),
          triggerMode: triggerMode || baseMeta.triggerMode || 'manual',
          workflowId: baseMeta.workflowId || null,
          workflowStepIndex: baseMeta.workflowStepIndex ?? null,
          isRolloverPart: slices.length > 1 || Boolean(baseMeta.hasRolledOver)
        };
        await this.storage.put('sessions', rec);
        this.sessions.push(rec);
        created.push(rec);
      }
      return created;
    }

    /**
     * Starts a labeled session timer.
     * - Automatically starts Master Timer if not yet started for today (idempotent).
     * - If another session is running, cleanly stops & records its actual elapsed time first.
     */
    async startSession(labelId, options = {}) {
      const nowMs = options.nowMs ?? Date.now();
      await this.reconcile(nowMs);

      const label = this.labels.get(labelId) || {
        id: labelId || U.uid('lbl'),
        name: options.labelName || 'Session',
        durationMin: options.durationMin || 25,
        category: options.category || 'other',
        color: options.color || '#FF5B42'
      };

      // Prevent duplicate timers: if one is active, save its actual elapsed time before switching
      if (this.runtime.activeSession) {
        await this.stopSession(nowMs, { keepWorkflow: Boolean(options.fromWorkflow) });
      }

      // Automatic Master Timer initialization (Scenario 1)
      await this.masterTimer.startForTimestamp(nowMs, true);

      const durationMin = Math.max(0.05, Number(options.durationMin ?? label.durationMin));
      const configuredMs = Math.round(durationMin * 60 * 1000);

      const active = {
        id: U.uid('run'),
        sessionGroupId: U.uid('grp'),
        labelId: label.id,
        labelName: options.labelName || label.name,
        category: options.category || label.category || 'other',
        color: options.color || label.color || '#FF5B42',
        configuredMs,
        startedAtMs: nowMs,
        segmentStartMs: nowMs,
        totalAccumulatedBeforeSegmentMs: 0,
        expectedEndMs: nowMs + configuredMs,
        isPaused: false,
        pausedAtMs: null,
        hasRolledOver: false,
        triggerMode: options.triggerMode || 'manual',
        workflowId: options.workflowId || null,
        workflowStepIndex: options.workflowStepIndex ?? null,
        workflowPhase: options.workflowPhase || 'activity'
      };

      this.runtime.activeSession = active;
      this.runtime.pendingCompletion = null;
      this.runtime.lastProcessedMs = nowMs;
      await this._persistRuntime();

      this.onEvent({ type: 'session_started', session: active, nowMs });
      return active;
    }

    /**
     * Starts an Automatic Sequence workflow from a chosen step index.
     */
    async startWorkflow(workflowId, startStepIndex = 0, nowMs = Date.now()) {
      const wf = this.workflowEngine.get(workflowId);
      if (!wf || wf.steps.length === 0) throw new Error('Workflow has no steps.');

      const stepIdx = Math.max(0, Math.min(startStepIndex, wf.steps.length - 1));
      const step = wf.steps[stepIdx];
      const lbl = this.labels.get(step.labelId);

      this.storage.savePrefs({ operatingMode: 'auto', activeWorkflowId: workflowId });
      this.runtime.activeWorkflow = {
        workflowId,
        currentStepIndex: stepIdx,
        phase: 'activity',
        isPaused: false
      };

      return this.startSession(step.labelId, {
        labelName: lbl ? lbl.name : step.labelName,
        category: lbl ? lbl.category : 'study',
        color: lbl ? lbl.color : '#421454',
        durationMin: step.durationMin,
        triggerMode: 'auto',
        workflowId,
        workflowStepIndex: stepIdx,
        workflowPhase: 'activity',
        fromWorkflow: true,
        nowMs
      });
    }

    async pauseSession(nowMs = Date.now()) {
      await this.reconcile(nowMs);
      const s = this.runtime.activeSession;
      if (!s || s.isPaused) return s;

      // Record the completed unpaused slice up to nowMs so pause gaps are accurately unallocated!
      if (nowMs > s.segmentStartMs) {
        const elapsedSlice = nowMs - s.segmentStartMs;
        await this._recordSessionSlices(s, s.segmentStartMs, nowMs, { completed: false });
        s.totalAccumulatedBeforeSegmentMs += elapsedSlice;
      }
      s.isPaused = true;
      s.pausedAtMs = nowMs;
      s.expectedEndMs = null;
      if (this.runtime.activeWorkflow) {
        this.runtime.activeWorkflow.isPaused = true;
      }
      this.runtime.lastProcessedMs = nowMs;
      await this._persistRuntime();
      this.onEvent({ type: 'session_paused', session: s, nowMs });
      return s;
    }

    async resumeSession(nowMs = Date.now()) {
      await this.reconcile(nowMs);
      const s = this.runtime.activeSession;
      if (!s || !s.isPaused) return s;

      await this.masterTimer.startForTimestamp(nowMs, true);
      const remainingMs = Math.max(1000, s.configuredMs - s.totalAccumulatedBeforeSegmentMs);
      s.isPaused = false;
      s.pausedAtMs = null;
      s.segmentStartMs = nowMs;
      s.expectedEndMs = nowMs + remainingMs;
      if (this.runtime.activeWorkflow) {
        this.runtime.activeWorkflow.isPaused = false;
      }
      this.runtime.lastProcessedMs = nowMs;
      await this._persistRuntime();
      this.onEvent({ type: 'session_resumed', session: s, nowMs });
      return s;
    }

    /**
     * Stops the active session early.
     * Records actual elapsed time with completed: false (Section 7B rule).
     */
    async stopSession(nowMs = Date.now(), { keepWorkflow = false } = {}) {
      const s = this.runtime.activeSession;
      if (!s) return null;

      if (!s.isPaused && nowMs > s.segmentStartMs) {
        const endTs = Math.min(nowMs, s.expectedEndMs || nowMs);
        if (endTs > s.segmentStartMs) {
          await this._recordSessionSlices(s, s.segmentStartMs, endTs, { completed: false });
          s.totalAccumulatedBeforeSegmentMs += (endTs - s.segmentStartMs);
        }
      }

      const stopped = { ...s };
      this.runtime.activeSession = null;
      if (!keepWorkflow) {
        this.runtime.activeWorkflow = null;
      }
      this.runtime.lastProcessedMs = nowMs;
      await this._persistRuntime();
      this.onEvent({ type: 'session_stopped', session: stopped, nowMs });
      return stopped;
    }

    /**
     * Manually finishes a timer early.
     * Records actual elapsed time; completed is true ONLY if elapsed >= configuredMs.
     */
    async finishSessionManually(nowMs = Date.now()) {
      await this.reconcile(nowMs);
      const s = this.runtime.activeSession;
      if (!s) return null;

      let totalActual = s.totalAccumulatedBeforeSegmentMs;
      if (!s.isPaused && nowMs > s.segmentStartMs) {
        const endTs = Math.min(nowMs, s.expectedEndMs || nowMs);
        const sliceMs = Math.max(0, endTs - s.segmentStartMs);
        totalActual += sliceMs;
        const reachedConfigured = totalActual >= s.configuredMs;
        if (sliceMs > 0) {
          await this._recordSessionSlices(s, s.segmentStartMs, endTs, { completed: reachedConfigured });
        }
      }

      const finished = { ...s, actualTotalMs: totalActual, completed: totalActual >= s.configuredMs };
      this.runtime.activeSession = null;
      this.runtime.lastProcessedMs = nowMs;

      // If in auto workflow, advance to next step if configured
      const nextInfo = await this._maybeAdvanceWorkflow(finished, nowMs);
      await this._persistRuntime();
      this.onEvent({ type: 'session_finished_manual', session: finished, nextInfo, nowMs });
      return finished;
    }

    async resetSession(nowMs = Date.now()) {
      const s = this.runtime.activeSession;
      if (!s) return null;
      // Record any already elapsed active time before resetting? No — reset restarts countdown from full configuredMs
      const labelId = s.labelId;
      const durationMin = s.configuredMs / 60000;
      const opts = {
        labelName: s.labelName,
        category: s.category,
        color: s.color,
        durationMin,
        triggerMode: s.triggerMode,
        workflowId: s.workflowId,
        workflowStepIndex: s.workflowStepIndex,
        workflowPhase: s.workflowPhase,
        fromWorkflow: Boolean(s.workflowId),
        nowMs
      };
      this.runtime.activeSession = null;
      await this._persistRuntime();
      return this.startSession(labelId, opts);
    }

    /**
     * Adds or subtracts remaining time (deltaMs can be positive or negative)
     * or sets a new total configured duration while running/paused.
     */
    async adjustRemainingTime(deltaMs, nowMs = Date.now()) {
      await this.reconcile(nowMs);
      const s = this.runtime.activeSession;
      if (!s) return null;

      const snap = this.getLiveSnapshot(nowMs);
      const newRemaining = Math.max(10000, snap.remainingMs + deltaMs); // floor at 10s
      const newConfigured = snap.elapsedMs + newRemaining;
      s.configuredMs = newConfigured;
      if (!s.isPaused) {
        s.expectedEndMs = nowMs + newRemaining;
      }
      this.runtime.lastProcessedMs = nowMs;
      await this._persistRuntime();
      this.onEvent({ type: 'session_adjusted', session: s, nowMs });
      return s;
    }

    async setActiveDurationMinutes(newMinutes, nowMs = Date.now()) {
      await this.reconcile(nowMs);
      const s = this.runtime.activeSession;
      if (!s) return null;
      const snap = this.getLiveSnapshot(nowMs);
      const targetConfigured = Math.max(60000, Math.round(newMinutes * 60 * 1000));
      s.configuredMs = Math.max(targetConfigured, snap.elapsedMs + 10000);
      if (!s.isPaused) {
        s.expectedEndMs = nowMs + (s.configuredMs - snap.elapsedMs);
      }
      await this._persistRuntime();
      this.onEvent({ type: 'session_adjusted', session: s, nowMs });
      return s;
    }

    async skipWorkflowStep(nowMs = Date.now()) {
      const wfState = this.runtime.activeWorkflow;
      if (!wfState) return null;
      await this.stopSession(nowMs, { keepWorkflow: true });
      const next = this.workflowEngine.resolveNextStep(wfState.workflowId, wfState.currentStepIndex, wfState.phase);
      if (!next) {
        this.runtime.activeWorkflow = null;
        await this._persistRuntime();
        return null;
      }
      return this._launchResolvedWorkflowStep(wfState.workflowId, next, nowMs);
    }

    async repeatWorkflowStep(nowMs = Date.now()) {
      const wfState = this.runtime.activeWorkflow;
      if (!wfState) return null;
      const wf = this.workflowEngine.get(wfState.workflowId);
      if (!wf || !wf.steps[wfState.currentStepIndex]) return null;
      return this.startWorkflow(wfState.workflowId, wfState.currentStepIndex, nowMs);
    }

    async stopWorkflow(nowMs = Date.now()) {
      this.runtime.activeWorkflow = null;
      await this.stopSession(nowMs, { keepWorkflow: false });
      await this._persistRuntime();
    }

    async _launchResolvedWorkflowStep(workflowId, next, startTs) {
      const lbl = this.labels.get(next.labelId);
      this.runtime.activeWorkflow = {
        workflowId,
        currentStepIndex: next.stepIndex,
        phase: next.phase,
        isPaused: false
      };
      return this.startSession(next.labelId, {
        labelName: lbl ? lbl.name : next.labelName,
        category: next.category || (lbl ? lbl.category : 'study'),
        color: lbl ? lbl.color : (next.phase === 'step_break' ? '#FFD749' : '#421454'),
        durationMin: next.durationMin,
        triggerMode: 'auto',
        workflowId,
        workflowStepIndex: next.stepIndex,
        workflowPhase: next.phase,
        fromWorkflow: true,
        nowMs: startTs
      });
    }

    async _maybeAdvanceWorkflow(completedSession, transitionTs) {
      const mode = this.storage.prefs.operatingMode;
      const wfState = this.runtime.activeWorkflow;
      if (mode !== 'auto' || !wfState || !completedSession.workflowId) {
        return { willAutoStart: false, nextStep: null };
      }

      const next = this.workflowEngine.resolveNextStep(
        wfState.workflowId,
        wfState.currentStepIndex,
        wfState.phase
      );
      if (!next) {
        this.runtime.activeWorkflow = null;
        return { willAutoStart: false, nextStep: null, sequenceComplete: true };
      }

      if (next.autoStart) {
        await this._launchResolvedWorkflowStep(wfState.workflowId, next, transitionTs);
        return { willAutoStart: true, nextStep: next };
      } else {
        // Keep workflow pointer ready for manual trigger
        this.runtime.activeWorkflow = {
          workflowId: wfState.workflowId,
          currentStepIndex: next.stepIndex,
          phase: next.phase,
          isPaused: true
        };
        return { willAutoStart: false, nextStep: next };
      }
    }

    /**
     * Core deterministic timestamp reconciliation.
     * Handles:
     * 1. Midnight rollover for active running sessions (preserving exact remaining time).
     * 2. Past day Master Timer finalization + new day Master Timer auto-initialization.
     * 3. Session completion detection + automatic workflow transitions (even if missed while closed/locked).
     */
    async reconcile(nowMs = Date.now()) {
      if (this._reconciling) return [];
      this._reconciling = true;
      const events = [];

      try {
        await this.masterTimer.finalizePastDays(nowMs);

        // Guard loop limit for extreme clock jumps (e.g. weeks offline)
        let safetyCounter = 0;
        while (this.runtime.activeSession && !this.runtime.activeSession.isPaused && safetyCounter < 50) {
          safetyCounter++;
          const s = this.runtime.activeSession;
          const segDateKey = U.getLocalDateKey(s.segmentStartMs);
          const { endMs: midnightMs } = U.getLocalDayBounds(segDateKey);

          // Case A: Midnight occurred BEFORE expectedEndMs AND BEFORE nowMs -> Rollover!
          if (midnightMs <= nowMs && midnightMs < s.expectedEndMs) {
            const elapsedBeforeMidnight = midnightMs - s.segmentStartMs;
            if (elapsedBeforeMidnight > 0) {
              await this._recordSessionSlices(s, s.segmentStartMs, midnightMs, { completed: false });
              s.totalAccumulatedBeforeSegmentMs += elapsedBeforeMidnight;
            }
            // Finalize previous day's Master Timer and auto-start new day's Master Timer at midnight
            await this.masterTimer.finalizePastDays(midnightMs);
            await this.masterTimer.startForTimestamp(midnightMs, true);

            // Continue remaining duration seamlessly on the new day
            s.segmentStartMs = midnightMs;
            s.hasRolledOver = true;
            this.runtime.lastProcessedMs = midnightMs;
            await this._persistRuntime();
            const ev = { type: 'midnight_rollover', prevDateKey: segDateKey, newDateKey: U.getLocalDateKey(midnightMs), session: { ...s } };
            events.push(ev);
            this.onEvent(ev);
            continue;
          }

          // Case B: Session reached expectedEndMs (at or before nowMs) -> Complete!
          if (nowMs >= s.expectedEndMs) {
            const endTs = s.expectedEndMs;
            const finalSliceMs = Math.max(0, endTs - s.segmentStartMs);
            if (finalSliceMs > 0) {
              await this._recordSessionSlices(s, s.segmentStartMs, endTs, { completed: true });
              s.totalAccumulatedBeforeSegmentMs += finalSliceMs;
            }
            // Ensure master timer finalized if endTs was exact midnight
            await this.masterTimer.finalizePastDays(endTs);

            const completed = {
              ...s,
              actualTotalMs: s.totalAccumulatedBeforeSegmentMs,
              completedAtMs: endTs,
              completed: true
            };

            this.runtime.activeSession = null;
            this.runtime.lastProcessedMs = endTs;

            const nextInfo = await this._maybeAdvanceWorkflow(completed, endTs);

            this.runtime.pendingCompletion = {
              session: completed,
              nextInfo,
              completedAtMs: endTs,
              wasMissedInBackground: (nowMs - endTs) > 3000
            };
            await this._persistRuntime();

            const ev = {
              type: 'session_completed',
              session: completed,
              nextInfo,
              wasMissedInBackground: (nowMs - endTs) > 3000,
              nowMs
            };
            events.push(ev);
            this.onEvent(ev);

            // If workflow auto-started next step at endTs, loop continues to reconcile up to nowMs!
            continue;
          }

          // Neither midnight nor completion reached yet
          break;
        }

        this.runtime.lastProcessedMs = nowMs;
        await this._persistRuntime();
      } finally {
        this._reconciling = false;
      }

      return events;
    }

    /**
     * Returns live remaining/elapsed snapshot without mutating state.
     */
    getLiveSnapshot(nowMs = Date.now()) {
      const s = this.runtime.activeSession;
      if (!s) {
        return {
          isActive: false,
          isPaused: false,
          elapsedMs: 0,
          remainingMs: 0,
          configuredMs: 0,
          progressPct: 0,
          session: null,
          liveSlice: null
        };
      }

      const currentSegmentElapsed = s.isPaused ? 0 : Math.max(0, Math.min(nowMs, s.expectedEndMs) - s.segmentStartMs);
      const elapsedMs = Math.min(s.configuredMs, s.totalAccumulatedBeforeSegmentMs + currentSegmentElapsed);
      const remainingMs = Math.max(0, s.configuredMs - elapsedMs);
      const progressPct = s.configuredMs > 0 ? Math.min(100, (elapsedMs / s.configuredMs) * 100) : 0;

      const liveSlice = (!s.isPaused && nowMs > s.segmentStartMs) ? {
        dateKey: U.getLocalDateKey(s.segmentStartMs),
        labelId: s.labelId,
        labelName: s.labelName,
        category: s.category,
        color: s.color,
        startMs: s.segmentStartMs,
        endMs: Math.min(nowMs, s.expectedEndMs),
        configuredMs: s.configuredMs,
        actualMs: currentSegmentElapsed,
        completed: false,
        triggerMode: s.triggerMode
      } : null;

      return {
        isActive: true,
        isPaused: s.isPaused,
        elapsedMs,
        remainingMs,
        configuredMs: s.configuredMs,
        progressPct,
        session: s,
        liveSlice
      };
    }

    /**
     * Manual correction: assigns an unallocated interval [startMs, endMs] to a label.
     */
    async addManualSessionCorrection({ labelId, startMs, endMs, notes = '' }) {
      if (endMs <= startMs) throw new Error('End time must be after start time.');
      const lbl = this.labels.get(labelId);
      if (!lbl) throw new Error('Label not found.');

      const baseMeta = {
        sessionGroupId: U.uid('corr'),
        labelId: lbl.id,
        labelName: lbl.name,
        category: lbl.category,
        color: lbl.color,
        configuredMs: endMs - startMs,
        triggerMode: 'manual_correction',
        notes
      };
      const created = await this._recordSessionSlices(baseMeta, startMs, endMs, {
        completed: true,
        triggerMode: 'manual_correction'
      });
      await this.masterTimer.startForTimestamp(startMs, true);
      this.onEvent({ type: 'sessions_updated' });
      return created;
    }

    async deleteSessionRecord(sessionId) {
      await this.storage.delete('sessions', sessionId);
      this.sessions = this.sessions.filter((s) => s.id !== sessionId);
      this.onEvent({ type: 'sessions_updated' });
    }
  }

  global.TimerEngine = TimerEngine;
})(typeof window !== 'undefined' ? window : globalThis);
