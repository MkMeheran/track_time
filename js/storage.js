/* ==========================================================================
   storage.js — Versioned IndexedDB persistence + safe localStorage prefs
   ========================================================================== */
(function (global) {
  'use strict';

  const DB_NAME = 'ChronoPlumTimeTrackerDB';
  const DB_VERSION = 1;
  const PREFS_KEY = 'chronoplum_prefs_v1';

  const STORES = [
    'labels',
    'sessions',
    'masterDays',
    'workflows',
    'sleepRecords',
    'runtimeState'
  ];

  const DEFAULT_PREFS = {
    theme: 'light',
    operatingMode: 'manual', // 'manual' | 'auto'
    activeWorkflowId: 'wf_default_study',
    alarmVolume: 0.9,
    alarmTone: 'chime-urgent', // 'chime-urgent' | 'bell-pulse' | 'siren-soft'
    notificationsEnabled: true,
    wakeLockEnabled: true,
    includeSleepInAnalytics: false
  };

  function createDefaultLabels() {
    const now = Date.now();
    return [
      {
        id: 'lbl_study',
        name: 'Study',
        durationMin: 50,
        description: 'Focused study and deep reading block',
        category: 'study',
        color: '#421454',
        icon: 'book',
        inAutoSequence: true,
        archived: false,
        createdAt: now
      },
      {
        id: 'lbl_break',
        name: 'Break',
        durationMin: 10,
        description: 'Intentional rest and recovery break',
        category: 'break',
        color: '#FFD749',
        icon: 'coffee',
        inAutoSequence: true,
        archived: false,
        createdAt: now + 1
      }
    ];
  }

  function createDefaultWorkflows() {
    const now = Date.now();
    return [
      {
        id: 'wf_default_study',
        name: 'Flexible Study Cycle',
        repeat: false,
        autoTransition: true,
        createdAt: now,
        steps: [
          { id: 'step_1', labelId: 'lbl_study', labelName: 'Study', durationMin: 50, breakDurationMin: 0, autoStartNext: true },
          { id: 'step_2', labelId: 'lbl_break', labelName: 'Break', durationMin: 10, breakDurationMin: 0, autoStartNext: true },
          { id: 'step_3', labelId: 'lbl_study', labelName: 'Study', durationMin: 45, breakDurationMin: 0, autoStartNext: true },
          { id: 'step_4', labelId: 'lbl_break', labelName: 'Break', durationMin: 15, breakDurationMin: 0, autoStartNext: false }
        ]
      }
    ];
  }

  class StorageEngine {
    constructor() {
      this.db = null;
      this.useMemoryFallback = false;
      this.mem = {};
      STORES.forEach((s) => { this.mem[s] = new Map(); });
      this.prefs = { ...DEFAULT_PREFS };
    }

    async init() {
      this.loadPrefs();
      if (typeof indexedDB === 'undefined') {
        this.useMemoryFallback = true;
      } else {
        try {
          this.db = await this._openDB();
        } catch (err) {
          console.warn('IndexedDB unavailable, using in-memory fallback:', err);
          this.useMemoryFallback = true;
        }
      }
      await this._seedDefaultsIfEmpty();
      return true;
    }

    _openDB() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (event) => {
          const db = event.target.result;
          // Safe additive migrations (never erase existing user stores)
          if (!db.objectStoreNames.contains('labels')) {
            db.createObjectStore('labels', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('sessions')) {
            const store = db.createObjectStore('sessions', { keyPath: 'id' });
            store.createIndex('dateKey', 'dateKey', { unique: false });
          }
          if (!db.objectStoreNames.contains('masterDays')) {
            db.createObjectStore('masterDays', { keyPath: 'dateKey' });
          }
          if (!db.objectStoreNames.contains('workflows')) {
            db.createObjectStore('workflows', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('sleepRecords')) {
            const store = db.createObjectStore('sleepRecords', { keyPath: 'id' });
            store.createIndex('dateKey', 'dateKey', { unique: false });
          }
          if (!db.objectStoreNames.contains('runtimeState')) {
            db.createObjectStore('runtimeState', { keyPath: 'id' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    async _seedDefaultsIfEmpty() {
      const labels = await this.getAll('labels');
      if (labels.length === 0) {
        for (const lbl of createDefaultLabels()) {
          await this.put('labels', lbl);
        }
      }
      const workflows = await this.getAll('workflows');
      if (workflows.length === 0) {
        for (const wf of createDefaultWorkflows()) {
          await this.put('workflows', wf);
        }
      }
      const runtime = await this.get('runtimeState', 'current');
      if (!runtime) {
        await this.put('runtimeState', {
          id: 'current',
          activeSession: null,
          activeWorkflow: null,
          lastProcessedMs: Date.now(),
          pendingCompletion: null
        });
      }
    }

    loadPrefs() {
      try {
        const raw = global.localStorage ? global.localStorage.getItem(PREFS_KEY) : null;
        if (raw) {
          this.prefs = { ...DEFAULT_PREFS, ...JSON.parse(raw) };
        }
      } catch (e) {
        this.prefs = { ...DEFAULT_PREFS };
      }
      return this.prefs;
    }

    savePrefs(patch) {
      this.prefs = { ...this.prefs, ...patch };
      try {
        if (global.localStorage) {
          global.localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
        }
      } catch (e) {
        // Ignore storage quota / sandbox restrictions
      }
      return this.prefs;
    }

    async getAll(storeName) {
      if (this.useMemoryFallback || !this.db) {
        return Array.from(this.mem[storeName].values()).map((v) => structuredClone(v));
      }
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    }

    async get(storeName, key) {
      if (this.useMemoryFallback || !this.db) {
        const val = this.mem[storeName].get(key);
        return val ? structuredClone(val) : null;
      }
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    }

    async put(storeName, record) {
      const key = storeName === 'masterDays' ? record.dateKey : record.id;
      if (this.useMemoryFallback || !this.db) {
        this.mem[storeName].set(key, structuredClone(record));
        return record;
      }
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(record);
        tx.oncomplete = () => resolve(record);
        tx.onerror = () => reject(tx.error);
      });
    }

    async delete(storeName, key) {
      if (this.useMemoryFallback || !this.db) {
        this.mem[storeName].delete(key);
        return true;
      }
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    }

    async clearStore(storeName) {
      if (this.useMemoryFallback || !this.db) {
        this.mem[storeName].clear();
        return true;
      }
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    }

    async getSessionsByDate(dateKey) {
      const all = await this.getAll('sessions');
      return all.filter((s) => s.dateKey === dateKey).sort((a, b) => a.startMs - b.startMs);
    }

    async exportAllData() {
      const data = {
        app: 'ChronoPlum Personal Time Tracker',
        schemaVersion: DB_VERSION,
        exportedAt: new Date().toISOString(),
        prefs: this.prefs,
        stores: {}
      };
      for (const name of STORES) {
        data.stores[name] = await this.getAll(name);
      }
      return data;
    }

    async importAllData(payload) {
      if (!payload || typeof payload !== 'object' || !payload.stores) {
        throw new Error('Invalid backup JSON format.');
      }
      for (const name of STORES) {
        if (Array.isArray(payload.stores[name])) {
          await this.clearStore(name);
          for (const item of payload.stores[name]) {
            await this.put(name, item);
          }
        }
      }
      if (payload.prefs && typeof payload.prefs === 'object') {
        this.savePrefs(payload.prefs);
      }
      await this._seedDefaultsIfEmpty();
      return true;
    }

    async clearHistoryOnly() {
      await this.clearStore('sessions');
      await this.clearStore('masterDays');
      await this.clearStore('sleepRecords');
      await this.put('runtimeState', {
        id: 'current',
        activeSession: null,
        activeWorkflow: null,
        lastProcessedMs: Date.now(),
        pendingCompletion: null
      });
      return true;
    }
  }

  global.StorageEngine = StorageEngine;
})(typeof window !== 'undefined' ? window : globalThis);
