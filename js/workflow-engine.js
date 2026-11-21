/* ==========================================================================
   workflow-engine.js — Custom Automatic Sequence Builder & Step Controller
   ========================================================================== */
(function (global) {
  'use strict';

  const U = global.TimeUtils;

  class WorkflowEngine {
    constructor(storage) {
      this.storage = storage;
      this.workflows = new Map();
    }

    async init() {
      const all = await this.storage.getAll('workflows');
      this.workflows.clear();
      for (const wf of all) {
        this.workflows.set(wf.id, wf);
      }
    }

    list() {
      return Array.from(this.workflows.values()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    }

    get(id) {
      return this.workflows.get(id) || null;
    }

    async saveWorkflow(wf) {
      const record = {
        id: wf.id || U.uid('wf'),
        name: (wf.name || 'Untitled Sequence').trim(),
        repeat: Boolean(wf.repeat),
        autoTransition: wf.autoTransition !== false,
        createdAt: wf.createdAt || Date.now(),
        steps: Array.isArray(wf.steps) ? wf.steps.map((s) => ({
          id: s.id || U.uid('step'),
          labelId: s.labelId,
          labelName: s.labelName,
          durationMin: Math.max(1, Number(s.durationMin) || 25),
          breakDurationMin: Math.max(0, Number(s.breakDurationMin) || 0),
          autoStartNext: s.autoStartNext !== false
        })) : []
      };
      await this.storage.put('workflows', record);
      this.workflows.set(record.id, record);
      return record;
    }

    async deleteWorkflow(id) {
      await this.storage.delete('workflows', id);
      this.workflows.delete(id);
    }

    async addStep(workflowId, step) {
      const wf = this.get(workflowId);
      if (!wf) throw new Error('Workflow not found');
      wf.steps.push({
        id: U.uid('step'),
        labelId: step.labelId,
        labelName: step.labelName,
        durationMin: Math.max(1, Number(step.durationMin) || 25),
        breakDurationMin: Math.max(0, Number(step.breakDurationMin) || 0),
        autoStartNext: step.autoStartNext !== false
      });
      return this.saveWorkflow(wf);
    }

    /**
     * Edits a specific occurrence (stepIndex) independently.
     * Does NOT alter an already running session unless caller explicitly requests it.
     */
    async editStep(workflowId, stepIndex, patch) {
      const wf = this.get(workflowId);
      if (!wf || !wf.steps[stepIndex]) throw new Error('Step not found');
      wf.steps[stepIndex] = {
        ...wf.steps[stepIndex],
        ...patch,
        durationMin: Math.max(1, Number(patch.durationMin ?? wf.steps[stepIndex].durationMin)),
        breakDurationMin: Math.max(0, Number(patch.breakDurationMin ?? wf.steps[stepIndex].breakDurationMin))
      };
      return this.saveWorkflow(wf);
    }

    async duplicateStep(workflowId, stepIndex) {
      const wf = this.get(workflowId);
      if (!wf || !wf.steps[stepIndex]) return null;
      const copy = { ...wf.steps[stepIndex], id: U.uid('step') };
      wf.steps.splice(stepIndex + 1, 0, copy);
      return this.saveWorkflow(wf);
    }

    async deleteStep(workflowId, stepIndex) {
      const wf = this.get(workflowId);
      if (!wf || !wf.steps[stepIndex]) return null;
      wf.steps.splice(stepIndex, 1);
      return this.saveWorkflow(wf);
    }

    async reorderStep(workflowId, fromIndex, toIndex) {
      const wf = this.get(workflowId);
      if (!wf) return null;
      if (toIndex < 0 || toIndex >= wf.steps.length) return wf;
      const [item] = wf.steps.splice(fromIndex, 1);
      wf.steps.splice(toIndex, 0, item);
      return this.saveWorkflow(wf);
    }

    /**
     * Resolves the next step in a workflow given the current state.
     * Supports optional per-step breakDurationMin as well as explicit Break steps.
     */
    resolveNextStep(workflowId, currentStepIndex, currentPhase = 'activity') {
      const wf = this.get(workflowId);
      if (!wf || wf.steps.length === 0) return null;

      const currStep = wf.steps[currentStepIndex];
      if (!currStep) return null;

      // If current step has an optional inline break and we just finished the activity phase
      if (currentPhase === 'activity' && currStep.breakDurationMin > 0) {
        return {
          stepIndex: currentStepIndex,
          phase: 'step_break',
          labelId: 'lbl_break',
          labelName: 'Break',
          category: 'break',
          durationMin: currStep.breakDurationMin,
          autoStart: wf.autoTransition && currStep.autoStartNext
        };
      }

      // Advance to next step index
      const nextIdx = currentStepIndex + 1;
      if (nextIdx < wf.steps.length) {
        const nextStep = wf.steps[nextIdx];
        return {
          stepIndex: nextIdx,
          phase: 'activity',
          labelId: nextStep.labelId,
          labelName: nextStep.labelName,
          durationMin: nextStep.durationMin,
          autoStart: wf.autoTransition && currStep.autoStartNext
        };
      }

      // End of sequence: repeat if enabled
      if (wf.repeat) {
        const firstStep = wf.steps[0];
        return {
          stepIndex: 0,
          phase: 'activity',
          labelId: firstStep.labelId,
          labelName: firstStep.labelName,
          durationMin: firstStep.durationMin,
          autoStart: wf.autoTransition && currStep.autoStartNext
        };
      }

      return null; // Sequence finished
    }
  }

  global.WorkflowEngine = WorkflowEngine;
})(typeof window !== 'undefined' ? window : globalThis);
