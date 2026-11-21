/* ==========================================================================
   app.js — UI Controller, Live Display Loop, Charts, Modals, Mobile Sheet & PWA
   ========================================================================== */
(function (global) {
  'use strict';

  const U = global.TimeUtils;
  const Analytics = global.AnalyticsEngine;
  const RING_CIRCUMFERENCE = 2 * Math.PI * 92;

  const ICONS = {
    up: '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"></polyline></svg>',
    down: '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>',
    copy: '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
    trash: '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path></svg>'
  };

  const state = {
    storage: null,
    masterTimer: null,
    workflowEngine: null,
    timerEngine: null,
    alarm: null,
    currentView: 'dashboard',
    selectedAnalyticsDate: U.getLocalDateKey(Date.now()),
    selectedWorkflowId: null,
    sleepRecords: [],
    lastCompletedSession: null,
    deferredInstallPrompt: null,
    uiInterval: null,
    dialogCallback: null
  };

  function $(id) {
    return document.getElementById(id);
  }

  function showToast(msg) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2800);
  }

  function openDialog({ title, message, showNumberInput = false, defaultValue = 25, confirmText = 'Confirm', onConfirm }) {
    $('dialogTitle').textContent = title;
    $('dialogMessage').textContent = message;
    $('dialogInputWrap').style.display = showNumberInput ? 'flex' : 'none';
    if (showNumberInput) {
      $('dialogNumberInput').value = defaultValue;
    }
    $('dialogConfirmBtn').textContent = confirmText;
    state.dialogCallback = onConfirm;
    $('dialogModal').classList.add('open');
  }

  function closeDialog() {
    $('dialogModal').classList.remove('open');
    state.dialogCallback = null;
  }

  function closeMobileSheet() {
    $('mobileMenuSheet').classList.remove('open');
    const btn = $('mobileMenuBtn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  /* ---------- Navigation ---------- */
  function switchView(viewName) {
    state.currentView = viewName;
    closeMobileSheet();
    document.querySelectorAll('.view-panel').forEach((p) => {
      p.classList.toggle('active', p.id === `view-${viewName}`);
    });
    document.querySelectorAll('.nav-tab[data-view]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });
    const isSecondary = ['history', 'sleep', 'settings'].includes(viewName);
    const menuBtn = $('mobileMenuBtn');
    if (menuBtn) menuBtn.classList.toggle('active', isSecondary);
    document.querySelectorAll('[data-sheet-view]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.sheetView === viewName);
    });
    renderCurrentView();
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
    const sw = $('toggleDarkTheme');
    if (sw) {
      sw.classList.toggle('on', theme === 'dark');
      sw.setAttribute('aria-checked', String(theme === 'dark'));
    }
  }

  function updateHeaderModeUI() {
    const isAuto = state.storage.prefs.operatingMode === 'auto';
    const btn = $('headerModeToggle');
    const txt = $('headerModeText');
    if (btn && txt) {
      btn.classList.toggle('auto-mode', isAuto);
      txt.textContent = isAuto ? 'Auto Sequence' : 'Manual Mode';
    }
    const wfBtn = $('wfModeSwitch');
    if (wfBtn) {
      wfBtn.textContent = isAuto ? 'Switch to Manual' : 'Switch to Automatic';
    }
  }

  /* ---------- Live Ticker (Display Only — Timestamps are Source of Truth) ---------- */
  async function tickDisplay() {
    const nowMs = Date.now();
    await state.timerEngine.reconcile(nowMs);
    updateLiveCounters(nowMs);
  }

  function updateLiveCounters(nowMs = Date.now()) {
    const masterSnap = state.masterTimer.getTodaySnapshot(nowMs);
    const liveSnap = state.timerEngine.getLiveSnapshot(nowMs);
    const todayStats = Analytics.computeDailyAnalytics({
      dateKey: masterSnap.dateKey,
      sessions: state.timerEngine.sessions,
      activeSessionLiveSlice: liveSnap.liveSlice,
      masterDay: state.masterTimer.getDayRecord(masterSnap.dateKey),
      sleepRecords: state.sleepRecords,
      nowMs,
      includeSleep: state.storage.prefs.includeSleepInAnalytics
    });

    $('masterDateLabel').textContent = `${U.formatDateHuman(masterSnap.dateKey)}${masterSnap.isRunning ? (masterSnap.autoStarted ? ' · Auto-started' : ' · Active') : ' · Not started'}`;
    $('masterDot').classList.toggle('live', masterSnap.isRunning);
    $('masterStartBtn').style.display = masterSnap.isRunning ? 'none' : 'inline-flex';
    $('masterElapsedVal').textContent = U.formatHMS(masterSnap.elapsedSinceStartMs);
    $('masterWastedVal').textContent = U.formatHMS(todayStats.unallocatedSinceMasterMs);
    $('masterRemainingVal').textContent = U.formatHMS(masterSnap.remainingInDayMs);
    $('masterProgressFill').style.width = `${masterSnap.dayProgressPct.toFixed(1)}%`;

    const ring = $('sessionRingProgress');
    if (liveSnap.isActive && liveSnap.session) {
      const s = liveSnap.session;
      $('activeSessionTitle').textContent = s.labelName;
      $('activeSessionDot').style.background = s.color || '#FF5B42';
      $('activeSessionModeTag').textContent = liveSnap.isPaused
        ? 'Paused'
        : (s.triggerMode === 'auto' ? 'Auto Sequence' : 'Running');
      $('sessionCountdown').textContent = U.formatCountdown(liveSnap.remainingMs);
      $('sessionElapsedInfo').textContent = `Elapsed ${U.formatCountdown(liveSnap.elapsedMs)} of ${U.formatDurationShort(liveSnap.configuredMs)}`;
      ring.style.stroke = s.category === 'break' ? '#FFD749' : '#FF5B42';
      ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - liveSnap.progressPct / 100));

      $('btnPauseResume').disabled = false;
      $('btnPauseResume').textContent = liveSnap.isPaused ? 'Resume' : 'Pause';
      $('btnFinishEarly').disabled = false;
      $('btnResetSession').disabled = false;
      $('btnStopSession').disabled = false;
      ['btnSub5', 'btnSub1', 'btnAdd1', 'btnAdd5', 'btnEditActiveDur'].forEach((id) => { $(id).disabled = false; });

      if (!liveSnap.isPaused) {
        state.alarm.requestWakeLock();
      } else {
        state.alarm.releaseWakeLock();
      }

      const wfState = state.timerEngine.runtime.activeWorkflow;
      if (wfState && s.workflowId) {
        const wf = state.workflowEngine.get(wfState.workflowId);
        $('activeWorkflowBar').style.display = 'flex';
        $('activeWfTitle').textContent = wf ? wf.name : 'Sequence';
        $('activeWfStepInfo').textContent = wf
          ? `Step ${wfState.currentStepIndex + 1} of ${wf.steps.length}${wfState.phase === 'step_break' ? ' (Inline Break)' : ''}`
          : '';
      } else {
        $('activeWorkflowBar').style.display = 'none';
      }
    } else {
      $('activeSessionTitle').textContent = 'No Active Session';
      $('activeSessionDot').style.background = '#802C62';
      $('activeSessionModeTag').textContent = 'Idle';
      $('sessionCountdown').textContent = '00:00';
      $('sessionElapsedInfo').textContent = 'Select a timer label below';
      ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
      $('btnPauseResume').disabled = true;
      $('btnPauseResume').textContent = 'Pause';
      $('btnFinishEarly').disabled = true;
      $('btnResetSession').disabled = true;
      $('btnStopSession').disabled = true;
      ['btnSub5', 'btnSub1', 'btnAdd1', 'btnAdd5', 'btnEditActiveDur'].forEach((id) => { $(id).disabled = true; });
      $('activeWorkflowBar').style.display = 'none';
      state.alarm.releaseWakeLock();
    }

    $('dashTodayKpis').innerHTML = `
      <div class="kpi-box">
        <div class="kpi-label">Study / Reading</div>
        <div class="kpi-val mono" style="color:var(--primary);">${U.formatDurationShort(todayStats.studyMs)}</div>
        <div class="kpi-sub">${todayStats.studyBlocks} recorded blocks</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-label">Break Time</div>
        <div class="kpi-val mono" style="color:var(--secondary);">${U.formatDurationShort(todayStats.breakMs)}</div>
        <div class="kpi-sub">${todayStats.completedBreaks} completed breaks</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-label">Other Labeled</div>
        <div class="kpi-val mono">${U.formatDurationShort(todayStats.otherMs)}</div>
        <div class="kpi-sub">${todayStats.otherBlocks} recorded blocks</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-label">Completed Sessions</div>
        <div class="kpi-val mono" style="color:var(--accent);">${todayStats.completedSessions}</div>
        <div class="kpi-sub">Allocated: ${U.formatDurationShort(todayStats.totalAllocatedMs)}</div>
      </div>
    `;
  }

  /* ---------- Render Views ---------- */
  function renderCurrentView() {
    updateHeaderModeUI();
    renderQuickLabels();
    if (state.currentView === 'timers') renderTimersView();
    if (state.currentView === 'workflows') renderWorkflowsView();
    if (state.currentView === 'analytics') renderAnalyticsView();
    if (state.currentView === 'history') renderHistoryView();
    if (state.currentView === 'sleep') renderSleepView();
    if (state.currentView === 'settings') renderSettingsView();
    updateLiveCounters(Date.now());
  }

  function renderQuickLabels() {
    const container = $('dashQuickLabels');
    const labels = state.timerEngine.getLabels(false);
    if (labels.length === 0) {
      container.innerHTML = '<div class="item-sub">No active labels yet. Select New Label to create one.</div>';
      return;
    }
    container.innerHTML = labels.map((l) => `
      <button class="quick-chip" type="button" data-start-label="${U.escapeHtml(l.id)}" style="--chip-color:${U.escapeHtml(l.color)};">
        <span class="quick-chip-name">${U.escapeHtml(l.name)}</span>
        <span class="quick-chip-meta mono">${l.durationMin} minutes · ${U.escapeHtml(l.category)}</span>
      </button>
    `).join('');

    container.querySelectorAll('[data-start-label]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        state.alarm.unlockAudio();
        await state.timerEngine.startSession(btn.dataset.startLabel, { triggerMode: 'manual' });
        showToast('Session started');
        renderCurrentView();
      });
    });
  }

  function renderTimersView() {
    const active = state.timerEngine.getLabels(false);
    const archived = state.timerEngine.getLabels(true).filter((l) => l.archived);

    $('timersActiveList').innerHTML = active.length === 0
      ? '<div class="item-sub">No active labels.</div>'
      : active.map((l) => `
        <div class="item-row">
          <div class="item-row-left">
            <span class="color-swatch" style="background:${U.escapeHtml(l.color)};"></span>
            <div>
              <div class="item-title">${U.escapeHtml(l.name)} <span class="tag">${U.escapeHtml(l.category)}</span></div>
              <div class="item-sub mono">${l.durationMin} minutes${l.description ? ' · ' + U.escapeHtml(l.description) : ''}</div>
            </div>
          </div>
          <div class="item-actions">
            <button class="btn btn-accent btn-sm" data-t-start="${U.escapeHtml(l.id)}" type="button">Start</button>
            <button class="btn btn-outline btn-sm" data-t-edit="${U.escapeHtml(l.id)}" type="button">Edit</button>
            <button class="btn btn-outline btn-sm" data-t-archive="${U.escapeHtml(l.id)}" type="button">Archive</button>
            <button class="btn btn-danger btn-sm" data-t-del="${U.escapeHtml(l.id)}" type="button">Delete</button>
          </div>
        </div>
      `).join('');

    $('timersArchivedList').innerHTML = archived.length === 0
      ? '<div class="item-sub">No archived labels.</div>'
      : archived.map((l) => `
        <div class="item-row">
          <div class="item-row-left">
            <span class="color-swatch" style="background:${U.escapeHtml(l.color)};"></span>
            <div>
              <div class="item-title">${U.escapeHtml(l.name)}</div>
              <div class="item-sub mono">${l.durationMin} minutes · archived</div>
            </div>
          </div>
          <div class="item-actions">
            <button class="btn btn-outline btn-sm" data-t-restore="${U.escapeHtml(l.id)}" type="button">Restore</button>
            <button class="btn btn-danger btn-sm" data-t-del="${U.escapeHtml(l.id)}" type="button">Delete</button>
          </div>
        </div>
      `).join('');

    $('timersActiveList').querySelectorAll('[data-t-start]').forEach((b) => {
      b.addEventListener('click', async () => {
        state.alarm.unlockAudio();
        await state.timerEngine.startSession(b.dataset.tStart, { triggerMode: 'manual' });
        switchView('dashboard');
      });
    });
    $('timersActiveList').querySelectorAll('[data-t-edit]').forEach((b) => {
      b.addEventListener('click', () => openLabelModal(state.timerEngine.getLabel(b.dataset.tEdit)));
    });
    $('timersActiveList').querySelectorAll('[data-t-archive]').forEach((b) => {
      b.addEventListener('click', async () => {
        const lbl = state.timerEngine.getLabel(b.dataset.tArchive);
        if (lbl) {
          await state.timerEngine.saveLabel({ ...lbl, archived: true });
          showToast('Label archived');
          renderCurrentView();
        }
      });
    });
    $('timersArchivedList').querySelectorAll('[data-t-restore]').forEach((b) => {
      b.addEventListener('click', async () => {
        const lbl = state.timerEngine.getLabel(b.dataset.tRestore);
        if (lbl) {
          await state.timerEngine.saveLabel({ ...lbl, archived: false });
          showToast('Label restored');
          renderCurrentView();
        }
      });
    });
    document.querySelectorAll('[data-t-del]').forEach((b) => {
      b.addEventListener('click', () => {
        openDialog({
          title: 'Delete Label',
          message: 'Delete this timer label? Existing historical session records will be preserved.',
          confirmText: 'Delete',
          onConfirm: async () => {
            await state.timerEngine.deleteLabel(b.dataset.tDel);
            showToast('Label deleted');
            renderCurrentView();
          }
        });
      });
    });
  }

  function renderWorkflowsView() {
    const workflows = state.workflowEngine.list();
    if (!state.selectedWorkflowId || !state.workflowEngine.get(state.selectedWorkflowId)) {
      state.selectedWorkflowId = workflows[0] ? workflows[0].id : null;
    }
    const sel = $('wfSelector');
    sel.innerHTML = workflows.map((w) => `<option value="${U.escapeHtml(w.id)}">${U.escapeHtml(w.name)}</option>`).join('');
    if (state.selectedWorkflowId) sel.value = state.selectedWorkflowId;

    const wf = state.workflowEngine.get(state.selectedWorkflowId);
    if (!wf) {
      $('wfStepsList').innerHTML = '<div class="item-sub">Create a sequence to begin.</div>';
      return;
    }

    $('wfNameInput').value = wf.name;
    $('wfAutoTransToggle').classList.toggle('on', wf.autoTransition);
    $('wfAutoTransToggle').setAttribute('aria-checked', String(wf.autoTransition));
    $('wfRepeatToggle').classList.toggle('on', wf.repeat);
    $('wfRepeatToggle').setAttribute('aria-checked', String(wf.repeat));

    const labels = state.timerEngine.getLabels(false);
    const activeWf = state.timerEngine.runtime.activeWorkflow;

    $('wfStepsList').innerHTML = wf.steps.length === 0
      ? '<div class="item-sub">No steps yet. Select Add Step to configure your sequence.</div>'
      : wf.steps.map((st, idx) => {
        const isCurrent = activeWf && activeWf.workflowId === wf.id && activeWf.currentStepIndex === idx;
        return `
          <div class="item-row step-row ${isCurrent ? 'current-step' : ''}">
            <div class="step-controls-inline">
              <span class="tag">Step ${idx + 1}</span>
              <select class="step-label-sel" data-step-idx="${idx}" aria-label="Step ${idx + 1} activity label" style="min-height:44px;padding:8px 10px;border-radius:10px;border:1px solid var(--border-strong);background:var(--surface);">
                ${labels.map((l) => `<option value="${U.escapeHtml(l.id)}" ${l.id === st.labelId ? 'selected' : ''}>${U.escapeHtml(l.name)}</option>`).join('')}
              </select>
              <input class="step-inline-min mono" type="number" min="1" max="600" value="${st.durationMin}" data-step-dur="${idx}" aria-label="Step ${idx + 1} duration in minutes" />
              <span class="item-sub">minutes</span>
            </div>
            <div class="item-actions">
              <button class="btn btn-outline btn-sm" data-step-up="${idx}" type="button" aria-label="Move step ${idx + 1} up" ${idx === 0 ? 'disabled' : ''}>${ICONS.up}</button>
              <button class="btn btn-outline btn-sm" data-step-down="${idx}" type="button" aria-label="Move step ${idx + 1} down" ${idx === wf.steps.length - 1 ? 'disabled' : ''}>${ICONS.down}</button>
              <button class="btn btn-outline btn-sm" data-step-dup="${idx}" type="button" aria-label="Duplicate step ${idx + 1}">${ICONS.copy}<span>Duplicate</span></button>
              <button class="btn btn-danger btn-sm" data-step-del="${idx}" type="button" aria-label="Remove step ${idx + 1}">${ICONS.trash}</button>
            </div>
          </div>
        `;
      }).join('');

    $('wfStepsList').querySelectorAll('[data-step-dur]').forEach((inp) => {
      inp.addEventListener('change', async () => {
        const idx = Number(inp.dataset.stepDur);
        const val = Math.max(1, Number(inp.value) || 25);
        await state.workflowEngine.editStep(wf.id, idx, { durationMin: val });
        showToast(`Step ${idx + 1} updated to ${val} minutes`);
      });
    });

    $('wfStepsList').querySelectorAll('[data-step-idx]').forEach((selEl) => {
      selEl.addEventListener('change', async () => {
        const idx = Number(selEl.dataset.stepIdx);
        const lbl = state.timerEngine.getLabel(selEl.value);
        if (lbl) {
          await state.workflowEngine.editStep(wf.id, idx, { labelId: lbl.id, labelName: lbl.name });
          showToast(`Step ${idx + 1} label updated`);
        }
      });
    });

    $('wfStepsList').querySelectorAll('[data-step-up]').forEach((b) => {
      b.addEventListener('click', async () => {
        const idx = Number(b.dataset.stepUp);
        await state.workflowEngine.reorderStep(wf.id, idx, idx - 1);
        renderWorkflowsView();
      });
    });
    $('wfStepsList').querySelectorAll('[data-step-down]').forEach((b) => {
      b.addEventListener('click', async () => {
        const idx = Number(b.dataset.stepDown);
        await state.workflowEngine.reorderStep(wf.id, idx, idx + 1);
        renderWorkflowsView();
      });
    });
    $('wfStepsList').querySelectorAll('[data-step-dup]').forEach((b) => {
      b.addEventListener('click', async () => {
        await state.workflowEngine.duplicateStep(wf.id, Number(b.dataset.stepDup));
        renderWorkflowsView();
      });
    });
    $('wfStepsList').querySelectorAll('[data-step-del]').forEach((b) => {
      b.addEventListener('click', async () => {
        await state.workflowEngine.deleteStep(wf.id, Number(b.dataset.stepDel));
        renderWorkflowsView();
      });
    });
  }

  function renderAnalyticsView() {
    const dk = state.selectedAnalyticsDate;
    $('analyticsDatePicker').value = dk;
    const nowMs = Date.now();
    const liveSnap = state.timerEngine.getLiveSnapshot(nowMs);
    const stats = Analytics.computeDailyAnalytics({
      dateKey: dk,
      sessions: state.timerEngine.sessions,
      activeSessionLiveSlice: liveSnap.liveSlice,
      masterDay: state.masterTimer.getDayRecord(dk),
      sleepRecords: state.sleepRecords,
      nowMs,
      includeSleep: state.storage.prefs.includeSleepInAnalytics
    });

    const wastedDisplayMs = stats.masterStarted ? stats.unallocatedSinceMasterMs : stats.fullDayUnallocatedMs;

    $('analyticsKpiGrid').innerHTML = `
      <div class="kpi-box">
        <div class="kpi-label">Study / Reading</div>
        <div class="kpi-val mono" style="color:var(--primary);">${U.formatDurationShort(stats.studyMs)}</div>
        <div class="kpi-sub">${stats.studyBlocks} recorded blocks</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-label">Break Time</div>
        <div class="kpi-val mono" style="color:var(--secondary);">${U.formatDurationShort(stats.breakMs)}</div>
        <div class="kpi-sub">${stats.completedBreaks} completed breaks</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-label">Other Labeled</div>
        <div class="kpi-val mono">${U.formatDurationShort(stats.otherMs)}</div>
        <div class="kpi-sub">${stats.otherBlocks} recorded blocks</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-label">Unallocated Time</div>
        <div class="kpi-val mono" style="color:var(--accent);">${U.formatDurationShort(wastedDisplayMs)}</div>
        <div class="kpi-sub">${stats.completedSessions} completed sessions</div>
      </div>
    `;

    const denom = Math.max(1, stats.studyMs + stats.breakMs + stats.otherMs + wastedDisplayMs);
    const pct = (v) => ((v / denom) * 100).toFixed(2);
    $('analyticsDistBar').innerHTML = `
      <div class="stacked-seg" style="width:${pct(stats.studyMs)}%;background:#421454;" title="Study"></div>
      <div class="stacked-seg" style="width:${pct(stats.breakMs)}%;background:#FFD749;" title="Break"></div>
      <div class="stacked-seg" style="width:${pct(stats.otherMs)}%;background:#802C62;" title="Other"></div>
      <div class="stacked-seg" style="width:${pct(wastedDisplayMs)}%;background:#FF5B42;opacity:0.48;" title="Unallocated"></div>
    `;
    $('analyticsDistLegend').innerHTML = `
      <span class="legend-item"><span class="color-swatch" style="background:#421454;"></span>Study ${U.formatDurationShort(stats.studyMs)}</span>
      <span class="legend-item"><span class="color-swatch" style="background:#FFD749;"></span>Break ${U.formatDurationShort(stats.breakMs)}</span>
      <span class="legend-item"><span class="color-swatch" style="background:#802C62;"></span>Other ${U.formatDurationShort(stats.otherMs)}</span>
      <span class="legend-item"><span class="color-swatch" style="background:#FF5B42;opacity:0.55;"></span>Unallocated ${U.formatDurationShort(wastedDisplayMs)}</span>
    `;

    const dayDur = Math.max(1, stats.bounds.durationMs);
    $('analyticsTimeline').innerHTML = stats.allIntervals.map((iv) => {
      const left = ((iv.startMs - stats.bounds.startMs) / dayDur) * 100;
      const width = Math.max(0.5, ((iv.endMs - iv.startMs) / dayDur) * 100);
      return `<div class="timeline-block" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;background:${U.escapeHtml(iv.color || '#421454')};" title="${U.escapeHtml(iv.labelName)} (${U.formatClockTime(iv.startMs)} to ${U.formatClockTime(iv.endMs)})"></div>`;
    }).join('');

    $('analyticsGapsList').innerHTML = stats.unallocatedGaps.length === 0
      ? '<div class="item-sub">No unallocated gaps of 1 minute or longer in this window.</div>'
      : stats.unallocatedGaps.slice(0, 12).map((g) => `
        <div class="item-row">
          <div>
            <div class="item-title mono">${U.formatClockTime(g.startMs)} – ${U.formatClockTime(g.endMs)}</div>
            <div class="item-sub">Unallocated duration: ${U.formatDurationShort(g.durationMs)}</div>
          </div>
          <button class="btn btn-outline btn-sm" data-assign-start="${g.startMs}" data-assign-end="${g.endMs}" type="button">Assign Label</button>
        </div>
      `).join('');

    $('analyticsGapsList').querySelectorAll('[data-assign-start]').forEach((b) => {
      b.addEventListener('click', () => {
        openCorrectionModal(dk, Number(b.dataset.assignStart), Number(b.dataset.assignEnd));
      });
    });

    $('analyticsSessionLog').innerHTML = stats.sessions.length === 0
      ? '<div class="item-sub">No recorded sessions for this day.</div>'
      : stats.sessions.map((s, idx) => `
        <div class="item-row">
          <div class="item-row-left">
            <span class="color-swatch" style="background:${U.escapeHtml(s.color || '#421454')};"></span>
            <div>
              <div class="item-title">Session ${idx + 1}: ${U.escapeHtml(s.labelName)}
                <span class="tag ${s.completed ? 'completed' : 'partial'}">${s.completed ? 'Completed' : 'Partial'}</span>
                <span class="tag">${U.escapeHtml(s.triggerMode)}</span>
              </div>
              <div class="item-sub mono">${U.formatClockTime(s.startMs)} – ${U.formatClockTime(s.endMs)} · Actual ${U.formatDurationShort(s.actualMs)} / Configured ${U.formatDurationShort(s.configuredMs)}</div>
            </div>
          </div>
          <button class="btn btn-danger btn-sm" data-del-sess="${U.escapeHtml(s.id)}" type="button">Remove</button>
        </div>
      `).join('');

    $('analyticsSessionLog').querySelectorAll('[data-del-sess]').forEach((b) => {
      b.addEventListener('click', async () => {
        await state.timerEngine.deleteSessionRecord(b.dataset.delSess);
        showToast('Session removed');
        renderAnalyticsView();
      });
    });
  }

  function renderHistoryView() {
    const nowMs = Date.now();
    const todayKey = U.getLocalDateKey(nowMs);
    const weekly = Analytics.computeWeeklySummary(
      todayKey,
      state.timerEngine.sessions,
      state.masterTimer.daysMap,
      state.sleepRecords,
      nowMs,
      state.storage.prefs.includeSleepInAnalytics
    );

    $('historyWeeklyKpis').innerHTML = `
      <div class="kpi-box">
        <div class="kpi-label">7-Day Study Total</div>
        <div class="kpi-val mono" style="color:var(--primary);">${U.formatDurationShort(weekly.totalStudyMs)}</div>
        <div class="kpi-sub">Average ${U.formatDurationShort(weekly.avgDailyStudyMs)} per active day</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-label">7-Day Break Total</div>
        <div class="kpi-val mono" style="color:var(--secondary);">${U.formatDurationShort(weekly.totalBreakMs)}</div>
        <div class="kpi-sub">${weekly.completedBreaks} completed breaks</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-label">7-Day Unallocated</div>
        <div class="kpi-val mono" style="color:var(--accent);">${U.formatDurationShort(weekly.totalUnallocatedMs)}</div>
        <div class="kpi-sub">Across ${weekly.activeDaysCount} tracked days</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-label">Completed Sessions</div>
        <div class="kpi-val mono">${weekly.completedSessions}</div>
        <div class="kpi-sub">Allocated: ${U.formatDurationShort(weekly.totalAllocatedMs)}</div>
      </div>
    `;

    $('historyDaysList').innerHTML = [...weekly.days].reverse().map((d) => `
      <div class="item-row">
        <div>
          <div class="item-title">${U.formatDateHuman(d.dateKey)} ${d.isToday ? '<span class="tag">Today</span>' : ''}</div>
          <div class="item-sub mono">Study ${U.formatDurationShort(d.studyMs)} · Break ${U.formatDurationShort(d.breakMs)} · Other ${U.formatDurationShort(d.otherMs)} · ${d.completedSessions} completed</div>
        </div>
        <button class="btn btn-outline btn-sm" data-open-day="${U.escapeHtml(d.dateKey)}" type="button">Inspect Day</button>
      </div>
    `).join('');

    $('historyDaysList').querySelectorAll('[data-open-day]').forEach((b) => {
      b.addEventListener('click', () => {
        state.selectedAnalyticsDate = b.dataset.openDay;
        switchView('analytics');
      });
    });
  }

  function renderSleepView() {
    if (!$('sleepDateInput').value) {
      $('sleepDateInput').value = U.getLocalDateKey(Date.now());
    }
    const incSw = $('toggleIncludeSleep');
    incSw.classList.toggle('on', state.storage.prefs.includeSleepInAnalytics);
    incSw.setAttribute('aria-checked', String(state.storage.prefs.includeSleepInAnalytics));

    const list = [...state.sleepRecords].sort((a, b) => b.sleepStartMs - a.sleepStartMs);
    $('sleepHistoryList').innerHTML = list.length === 0
      ? '<div class="item-sub">No sleep records entered yet.</div>'
      : list.map((r) => `
        <div class="item-row">
          <div>
            <div class="item-title">${U.formatDateHuman(r.dateKey)} · <span class="mono">${U.formatDurationShort(r.durationMs)}</span></div>
            <div class="item-sub mono">${U.formatClockTime(r.sleepStartMs)} to ${U.formatClockTime(r.wakeUpMs)}${r.notes ? ' · ' + U.escapeHtml(r.notes) : ''}</div>
          </div>
          <button class="btn btn-danger btn-sm" data-del-sleep="${U.escapeHtml(r.id)}" type="button">Delete</button>
        </div>
      `).join('');

    $('sleepHistoryList').querySelectorAll('[data-del-sleep]').forEach((b) => {
      b.addEventListener('click', async () => {
        await state.storage.delete('sleepRecords', b.dataset.delSleep);
        state.sleepRecords = await state.storage.getAll('sleepRecords');
        showToast('Sleep entry removed');
        renderSleepView();
      });
    });
  }

  function renderSettingsView() {
    const p = state.storage.prefs;
    $('alarmToneSelect').value = p.alarmTone;
    $('alarmVolumeRange').value = p.alarmVolume;
    $('alarmVolLabel').textContent = `${Math.round(p.alarmVolume * 100)}%`;

    const perm = state.alarm.getNotificationPermission();
    $('notifPermBadge').textContent = perm === 'granted' ? 'Enabled' : (perm === 'unsupported' ? 'Unsupported' : perm);

    $('toggleWakeLock').classList.toggle('on', p.wakeLockEnabled);
    $('toggleWakeLock').setAttribute('aria-checked', String(p.wakeLockEnabled));
    applyTheme(p.theme);
  }

  /* ---------- Modals ---------- */
  function openLabelModal(existing = null) {
    $('labelModalTitle').textContent = existing ? 'Edit Timer Label' : 'Add Timer Label';
    $('lblIdInput').value = existing ? existing.id : '';
    $('lblNameInput').value = existing ? existing.name : '';
    $('lblDurInput').value = existing ? existing.durationMin : 50;
    $('lblCatSelect').value = existing ? existing.category : 'study';
    $('lblColorSelect').value = existing ? existing.color : '#421454';
    $('lblAutoSeqCheck').value = existing ? String(existing.inAutoSequence) : 'true';
    $('lblDescInput').value = existing ? (existing.description || '') : '';
    $('labelModal').classList.add('open');
  }

  function openCorrectionModal(dateKey, startMs, endMs) {
    $('corrDateInput').value = dateKey;
    const labels = state.timerEngine.getLabels(false);
    $('corrLabelSelect').innerHTML = labels.map((l) => `<option value="${U.escapeHtml(l.id)}">${U.escapeHtml(l.name)}</option>`).join('');
    $('corrStartInput').value = U.formatClockTime(startMs);
    $('corrEndInput').value = U.formatClockTime(endMs);
    $('correctionModal').classList.add('open');
  }

  function showCompletionAlarmModal(completed, nextInfo, wasMissed) {
    state.lastCompletedSession = completed;
    $('alarmModalTitle').textContent = `${completed.labelName} Completed`;
    $('alarmModalBody').textContent = `Configured: ${U.formatDurationShort(completed.configuredMs)} · Actual: ${U.formatDurationShort(completed.actualTotalMs || completed.configuredMs)}${wasMissed ? ' (Completed while app was in background)' : ''}`;
    $('alarmAutoNextNote').textContent = nextInfo && nextInfo.willAutoStart
      ? `Automatic Sequence started next: ${nextInfo.nextStep.labelName} (${nextInfo.nextStep.durationMin} minutes)`
      : 'Manual Mode — choose your next action';

    $('alarmModal').classList.add('open');
    state.alarm.startAlarmLoop();
    state.alarm.sendSystemNotification(
      `${completed.labelName} Finished`,
      `Completed ${U.formatDurationShort(completed.configuredMs)}. ${nextInfo && nextInfo.willAutoStart ? 'Next step started automatically.' : 'Open ChronoPlum to continue.'}`
    );
  }

  /* ---------- Event Wiring ---------- */
  function bindEvents() {
    document.querySelectorAll('.nav-tab[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });
    $('btnJumpAnalytics').addEventListener('click', () => switchView('analytics'));

    // Mobile Menu Sheet
    $('mobileMenuBtn').addEventListener('click', () => {
      const sheet = $('mobileMenuSheet');
      const open = !sheet.classList.contains('open');
      sheet.classList.toggle('open', open);
      $('mobileMenuBtn').setAttribute('aria-expanded', String(open));
    });
    $('closeMobileMenuBtn').addEventListener('click', closeMobileSheet);
    $('mobileMenuSheet').addEventListener('click', (e) => {
      if (e.target === $('mobileMenuSheet')) closeMobileSheet();
    });
    document.querySelectorAll('[data-sheet-view]').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.sheetView));
    });

    // Header actions
    $('headerModeToggle').addEventListener('click', () => {
      const next = state.storage.prefs.operatingMode === 'auto' ? 'manual' : 'auto';
      state.storage.savePrefs({ operatingMode: next });
      updateHeaderModeUI();
      showToast(next === 'auto' ? 'Switched to Automatic Sequence Mode' : 'Switched to Manual Mode');
    });

    $('themeToggleBtn').addEventListener('click', () => {
      const next = state.storage.prefs.theme === 'dark' ? 'light' : 'dark';
      state.storage.savePrefs({ theme: next });
      applyTheme(next);
    });

    $('masterStartBtn').addEventListener('click', async () => {
      state.alarm.unlockAudio();
      await state.masterTimer.startForTimestamp(Date.now(), false);
      showToast('Master Timer started for today');
      updateLiveCounters(Date.now());
    });

    // Active Session Controls
    $('btnPauseResume').addEventListener('click', async () => {
      const snap = state.timerEngine.getLiveSnapshot(Date.now());
      if (!snap.isActive) return;
      if (snap.isPaused) {
        await state.timerEngine.resumeSession(Date.now());
        showToast('Session resumed');
      } else {
        await state.timerEngine.pauseSession(Date.now());
        showToast('Session paused');
      }
      renderCurrentView();
    });

    $('btnFinishEarly').addEventListener('click', async () => {
      await state.timerEngine.finishSessionManually(Date.now());
      showToast('Session finished — actual elapsed time recorded');
      renderCurrentView();
    });

    $('btnResetSession').addEventListener('click', async () => {
      await state.timerEngine.resetSession(Date.now());
      showToast('Session reset');
      renderCurrentView();
    });

    $('btnStopSession').addEventListener('click', async () => {
      await state.timerEngine.stopSession(Date.now());
      showToast('Session stopped — actual time saved');
      renderCurrentView();
    });

    $('btnSub5').addEventListener('click', async () => { await state.timerEngine.adjustRemainingTime(-5 * 60000); updateLiveCounters(); });
    $('btnSub1').addEventListener('click', async () => { await state.timerEngine.adjustRemainingTime(-60000); updateLiveCounters(); });
    $('btnAdd1').addEventListener('click', async () => { await state.timerEngine.adjustRemainingTime(60000); updateLiveCounters(); });
    $('btnAdd5').addEventListener('click', async () => { await state.timerEngine.adjustRemainingTime(5 * 60000); updateLiveCounters(); });
    $('btnEditActiveDur').addEventListener('click', () => {
      const snap = state.timerEngine.getLiveSnapshot(Date.now());
      if (!snap.isActive) return;
      openDialog({
        title: 'Edit Active Session Duration',
        message: 'Enter the new total duration in minutes for the running session:',
        showNumberInput: true,
        defaultValue: Math.round(snap.configuredMs / 60000),
        confirmText: 'Apply',
        onConfirm: async (val) => {
          await state.timerEngine.setActiveDurationMinutes(Number(val) || 25, Date.now());
          showToast('Duration updated');
          updateLiveCounters();
        }
      });
    });

    $('btnWfRepeatStep').addEventListener('click', async () => {
      await state.timerEngine.repeatWorkflowStep(Date.now());
      showToast('Repeating current workflow step');
      renderCurrentView();
    });
    $('btnWfSkipStep').addEventListener('click', async () => {
      await state.timerEngine.skipWorkflowStep(Date.now());
      showToast('Advanced to next workflow step');
      renderCurrentView();
    });
    $('btnWfStopAll').addEventListener('click', async () => {
      await state.timerEngine.stopWorkflow(Date.now());
      showToast('Workflow stopped');
      renderCurrentView();
    });

    // Label Modal
    $('btnDashAddLabel').addEventListener('click', () => openLabelModal(null));
    $('btnOpenNewLabelModal').addEventListener('click', () => openLabelModal(null));
    $('closeLabelModal').addEventListener('click', () => $('labelModal').classList.remove('open'));
    $('labelForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      await state.timerEngine.saveLabel({
        id: $('lblIdInput').value || undefined,
        name: $('lblNameInput').value,
        durationMin: Number($('lblDurInput').value),
        category: $('lblCatSelect').value,
        color: $('lblColorSelect').value,
        inAutoSequence: $('lblAutoSeqCheck').value === 'true',
        description: $('lblDescInput').value
      });
      $('labelModal').classList.remove('open');
      showToast('Timer label saved');
      renderCurrentView();
    });

    // Workflows
    $('wfModeSwitch').addEventListener('click', () => $('headerModeToggle').click());
    $('wfSelector').addEventListener('change', () => {
      state.selectedWorkflowId = $('wfSelector').value;
      renderWorkflowsView();
    });
    $('btnCreateWorkflow').addEventListener('click', async () => {
      const labels = state.timerEngine.getLabels(false);
      const first = labels[0] || { id: 'lbl_study', name: 'Study', durationMin: 50 };
      const wf = await state.workflowEngine.saveWorkflow({
        name: `Custom Sequence ${state.workflowEngine.list().length + 1}`,
        repeat: false,
        autoTransition: true,
        steps: [{ labelId: first.id, labelName: first.name, durationMin: first.durationMin, breakDurationMin: 0, autoStartNext: true }]
      });
      state.selectedWorkflowId = wf.id;
      showToast('New sequence created');
      renderWorkflowsView();
    });
    $('wfAutoTransToggle').addEventListener('click', async () => {
      const wf = state.workflowEngine.get(state.selectedWorkflowId);
      if (!wf) return;
      wf.autoTransition = !wf.autoTransition;
      await state.workflowEngine.saveWorkflow(wf);
      renderWorkflowsView();
    });
    $('wfRepeatToggle').addEventListener('click', async () => {
      const wf = state.workflowEngine.get(state.selectedWorkflowId);
      if (!wf) return;
      wf.repeat = !wf.repeat;
      await state.workflowEngine.saveWorkflow(wf);
      renderWorkflowsView();
    });
    $('btnSaveWfMeta').addEventListener('click', async () => {
      const wf = state.workflowEngine.get(state.selectedWorkflowId);
      if (!wf) return;
      wf.name = $('wfNameInput').value.trim() || wf.name;
      await state.workflowEngine.saveWorkflow(wf);
      showToast('Workflow saved');
      renderWorkflowsView();
    });
    $('btnDeleteWf').addEventListener('click', () => {
      if (!state.selectedWorkflowId) return;
      openDialog({
        title: 'Delete Workflow',
        message: 'Remove this workflow sequence?',
        confirmText: 'Delete',
        onConfirm: async () => {
          await state.workflowEngine.deleteWorkflow(state.selectedWorkflowId);
          state.selectedWorkflowId = null;
          showToast('Workflow deleted');
          renderWorkflowsView();
        }
      });
    });
    $('btnAddWfStep').addEventListener('click', async () => {
      const wf = state.workflowEngine.get(state.selectedWorkflowId);
      if (!wf) return;
      const labels = state.timerEngine.getLabels(false);
      const pick = labels[0] || { id: 'lbl_study', name: 'Study', durationMin: 50 };
      await state.workflowEngine.addStep(wf.id, {
        labelId: pick.id,
        labelName: pick.name,
        durationMin: pick.durationMin,
        breakDurationMin: 0,
        autoStartNext: true
      });
      renderWorkflowsView();
    });
    $('btnStartSelectedWf').addEventListener('click', async () => {
      if (!state.selectedWorkflowId) return;
      state.alarm.unlockAudio();
      await state.timerEngine.startWorkflow(state.selectedWorkflowId, 0, Date.now());
      showToast('Automatic sequence started');
      switchView('dashboard');
    });

    // Analytics
    $('analyticsDatePicker').addEventListener('change', () => {
      state.selectedAnalyticsDate = $('analyticsDatePicker').value || U.getLocalDateKey(Date.now());
      renderAnalyticsView();
    });
    $('btnManualLogModal').addEventListener('click', () => {
      const now = Date.now();
      openCorrectionModal(state.selectedAnalyticsDate, now - 30 * 60000, now);
    });
    $('closeCorrModal').addEventListener('click', () => $('correctionModal').classList.remove('open'));
    $('correctionForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const dk = $('corrDateInput').value;
      const startMs = U.timeInputToMs(dk, $('corrStartInput').value);
      const endMs = U.timeInputToMs(dk, $('corrEndInput').value);
      if (!startMs || !endMs || endMs <= startMs) {
        showToast('End time must be after start time');
        return;
      }
      await state.timerEngine.addManualSessionCorrection({
        labelId: $('corrLabelSelect').value,
        startMs,
        endMs
      });
      $('correctionModal').classList.remove('open');
      showToast('Interval assigned to label');
      renderCurrentView();
    });

    // Sleep
    const updateSleepPreview = () => {
      const dk = $('sleepDateInput').value || U.getLocalDateKey(Date.now());
      let sMs = U.timeInputToMs(dk, $('sleepStartInput').value);
      let eMs = U.timeInputToMs(dk, $('sleepWakeInput').value);
      if (sMs && eMs) {
        if (eMs <= sMs) eMs += 24 * 3600 * 1000;
        $('sleepComputedPreview').textContent = `Duration: ${U.formatDurationShort(eMs - sMs)}`;
      }
    };
    ['sleepDateInput', 'sleepStartInput', 'sleepWakeInput'].forEach((id) => {
      $(id).addEventListener('change', updateSleepPreview);
    });
    $('sleepForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const dk = $('sleepDateInput').value;
      const sMs = U.timeInputToMs(dk, $('sleepStartInput').value);
      let eMs = U.timeInputToMs(dk, $('sleepWakeInput').value);
      if (!sMs || !eMs) return;
      if (eMs <= sMs) eMs += 24 * 3600 * 1000;
      const rec = {
        id: U.uid('sleep'),
        dateKey: dk,
        sleepStartMs: sMs,
        wakeUpMs: eMs,
        durationMs: eMs - sMs,
        notes: $('sleepNotesInput').value.trim()
      };
      await state.storage.put('sleepRecords', rec);
      state.sleepRecords = await state.storage.getAll('sleepRecords');
      $('sleepNotesInput').value = '';
      showToast('Sleep record saved');
      renderSleepView();
    });
    $('toggleIncludeSleep').addEventListener('click', () => {
      const next = !state.storage.prefs.includeSleepInAnalytics;
      state.storage.savePrefs({ includeSleepInAnalytics: next });
      renderSleepView();
      showToast(next ? 'Sleep included in custom analytics' : 'Sleep separated from activity tracking');
    });

    // Settings
    $('alarmToneSelect').addEventListener('change', () => {
      state.storage.savePrefs({ alarmTone: $('alarmToneSelect').value });
    });
    $('alarmVolumeRange').addEventListener('input', () => {
      const v = Number($('alarmVolumeRange').value);
      $('alarmVolLabel').textContent = `${Math.round(v * 100)}%`;
      state.storage.savePrefs({ alarmVolume: v });
    });
    $('btnTestAlarm').addEventListener('click', () => state.alarm.testAlarm());
    $('btnReqNotif').addEventListener('click', async () => {
      const perm = await state.alarm.requestNotificationPermission();
      renderSettingsView();
      showToast(`Notification status: ${perm}`);
    });
    $('toggleWakeLock').addEventListener('click', () => {
      const next = !state.storage.prefs.wakeLockEnabled;
      state.storage.savePrefs({ wakeLockEnabled: next });
      if (!next) state.alarm.releaseWakeLock();
      renderSettingsView();
    });
    $('toggleDarkTheme').addEventListener('click', () => {
      const next = state.storage.prefs.theme === 'dark' ? 'light' : 'dark';
      state.storage.savePrefs({ theme: next });
      applyTheme(next);
    });

    // Backup / Restore / Clear
    $('btnExportJson').addEventListener('click', async () => {
      const data = await state.storage.exportAllData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `chronoplum-backup-${U.getLocalDateKey(Date.now())}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('JSON backup exported');
    });
    $('importJsonInput').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        await state.storage.importAllData(JSON.parse(text));
        await state.masterTimer.init();
        await state.workflowEngine.init();
        await state.timerEngine.init(Date.now());
        state.sleepRecords = await state.storage.getAll('sleepRecords');
        showToast('Backup restored successfully');
        renderCurrentView();
      } catch (err) {
        showToast('Invalid backup file');
      }
      e.target.value = '';
    });
    $('btnClearHistory').addEventListener('click', () => {
      openDialog({
        title: 'Clear All History',
        message: 'Erase all recorded sessions, daily master records, and sleep logs? Your custom labels and workflows will remain intact.',
        confirmText: 'Clear History',
        onConfirm: async () => {
          await state.storage.clearHistoryOnly();
          await state.masterTimer.init();
          await state.timerEngine.init(Date.now());
          state.sleepRecords = [];
          showToast('History cleared');
          renderCurrentView();
        }
      });
    });

    // Alarm Modal Controls
    const closeAlarm = () => {
      state.alarm.stopAlarm();
      $('alarmModal').classList.remove('open');
      state.timerEngine.runtime.pendingCompletion = null;
      state.timerEngine._persistRuntime();
    };
    $('btnAlarmStop').addEventListener('click', () => state.alarm.stopAlarm());
    $('btnAlarmDismiss').addEventListener('click', closeAlarm);
    $('btnAlarmRepeat').addEventListener('click', async () => {
      const prev = state.lastCompletedSession;
      closeAlarm();
      if (prev) {
        await state.timerEngine.startSession(prev.labelId, {
          durationMin: prev.configuredMs / 60000,
          triggerMode: 'manual'
        });
        renderCurrentView();
      }
    });
    $('btnAlarmSnooze').addEventListener('click', async () => {
      const prev = state.lastCompletedSession;
      closeAlarm();
      if (prev) {
        await state.timerEngine.startSession(prev.labelId, {
          durationMin: 5,
          triggerMode: 'manual'
        });
        showToast('Snoozed for 5 minutes');
        renderCurrentView();
      }
    });

    // Generic Dialog Controls
    $('dialogCancelBtn').addEventListener('click', closeDialog);
    $('dialogConfirmBtn').addEventListener('click', async () => {
      const cb = state.dialogCallback;
      const val = $('dialogNumberInput').value;
      closeDialog();
      if (cb) await cb(val);
    });

    // Keyboard Escape closes open dialogs/sheets
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeMobileSheet();
        closeDialog();
        $('labelModal').classList.remove('open');
        $('correctionModal').classList.remove('open');
      }
    });

    // Background Recovery & Screen Lock Wake Hooks
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        tickDisplay();
      }
    });
    window.addEventListener('focus', () => tickDisplay());
    window.addEventListener('pageshow', () => tickDisplay());

    // PWA Install Prompt
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.deferredInstallPrompt = e;
      $('installPwaBtn').style.display = 'inline-flex';
    });
    $('installPwaBtn').addEventListener('click', async () => {
      if (!state.deferredInstallPrompt) return;
      state.deferredInstallPrompt.prompt();
      await state.deferredInstallPrompt.userChoice;
      state.deferredInstallPrompt = null;
      $('installPwaBtn').style.display = 'none';
    });
  }

  /* ---------- Bootstrap ---------- */
  async function boot() {
    state.storage = new global.StorageEngine();
    await state.storage.init();

    state.masterTimer = new global.MasterTimerEngine(state.storage);
    await state.masterTimer.init();

    state.workflowEngine = new global.WorkflowEngine(state.storage);
    await state.workflowEngine.init();

    state.alarm = new global.NotificationAlarmManager(state.storage);

    state.timerEngine = new global.TimerEngine({
      storage: state.storage,
      masterTimer: state.masterTimer,
      workflowEngine: state.workflowEngine,
      onEvent: (ev) => {
        if (ev.type === 'session_completed') {
          showCompletionAlarmModal(ev.session, ev.nextInfo, ev.wasMissedInBackground);
          renderCurrentView();
        } else if (ev.type === 'midnight_rollover') {
          showToast(`Midnight rollover: continued on ${ev.newDateKey}`);
          renderCurrentView();
        }
      }
    });

    state.sleepRecords = await state.storage.getAll('sleepRecords');
    applyTheme(state.storage.prefs.theme);
    bindEvents();

    await state.timerEngine.init(Date.now());
    renderCurrentView();

    if (state.timerEngine.runtime.pendingCompletion) {
      const pc = state.timerEngine.runtime.pendingCompletion;
      showCompletionAlarmModal(pc.session, pc.nextInfo, true);
    }

    if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('./service-worker.js').catch(() => {});
    }

    if (state.uiInterval) clearInterval(state.uiInterval);
    state.uiInterval = setInterval(tickDisplay, 250);
  }

  document.addEventListener('DOMContentLoaded', boot);
})(typeof window !== 'undefined' ? window : globalThis);
