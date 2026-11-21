/* ==========================================================================
   notifications.js — Loud Web Audio Alarm, Web Notifications, Vibration &
                      Screen Wake Lock API (Android PWA-compatible)
   ========================================================================== */
(function (global) {
  'use strict';

  class NotificationAlarmManager {
    constructor(storage) {
      this.storage = storage;
      this.audioCtx = null;
      this.alarmInterval = null;
      this.isRinging = false;
      this.wakeLockSentinel = null;
    }

    /**
     * Unlocks AudioContext on first user gesture (required by Chrome/Android).
     */
    unlockAudio() {
      try {
        const Ctx = global.AudioContext || global.webkitAudioContext;
        if (!Ctx) return;
        if (!this.audioCtx) {
          this.audioCtx = new Ctx();
        }
        if (this.audioCtx.state === 'suspended') {
          this.audioCtx.resume().catch(() => {});
        }
      } catch (e) {
        // Ignore
      }
    }

    getNotificationPermission() {
      if (typeof Notification === 'undefined') return 'unsupported';
      return Notification.permission;
    }

    async requestNotificationPermission() {
      if (typeof Notification === 'undefined') return 'unsupported';
      if (Notification.permission === 'granted') return 'granted';
      try {
        return await Notification.requestPermission();
      } catch (e) {
        return 'denied';
      }
    }

    /**
     * Plays one loud, attention-grabbing alarm burst using Web Audio API.
     */
    _playBurst(tone = 'chime-urgent', volume = 0.9) {
      try {
        this.unlockAudio();
        const ctx = this.audioCtx;
        if (!ctx) return;

        const now = ctx.currentTime;
        const gainLevel = Math.max(0.05, Math.min(1.0, Number(volume) || 0.9));

        const patterns = {
          'chime-urgent': [
            { f: 880, start: 0.0, dur: 0.16, type: 'triangle' },
            { f: 1174.66, start: 0.18, dur: 0.16, type: 'triangle' },
            { f: 1567.98, start: 0.36, dur: 0.24, type: 'sawtooth' },
            { f: 1174.66, start: 0.66, dur: 0.16, type: 'triangle' },
            { f: 1567.98, start: 0.84, dur: 0.30, type: 'sawtooth' }
          ],
          'bell-pulse': [
            { f: 784, start: 0.0, dur: 0.22, type: 'sine' },
            { f: 1046.5, start: 0.26, dur: 0.22, type: 'sine' },
            { f: 1318.5, start: 0.52, dur: 0.35, type: 'triangle' }
          ],
          'siren-soft': [
            { f: 660, start: 0.0, dur: 0.28, type: 'square' },
            { f: 990, start: 0.30, dur: 0.28, type: 'square' },
            { f: 660, start: 0.60, dur: 0.28, type: 'square' }
          ]
        };

        const notes = patterns[tone] || patterns['chime-urgent'];
        for (const n of notes) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = n.type;
          osc.frequency.setValueAtTime(n.f, now + n.start);

          gain.gain.setValueAtTime(0.0001, now + n.start);
          gain.gain.exponentialRampToValueAtTime(gainLevel * 0.45, now + n.start + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + n.start + n.dur);

          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now + n.start);
          osc.stop(now + n.start + n.dur + 0.02);
        }

        // Android vibration fallback if supported
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
          navigator.vibrate([300, 120, 300, 120, 450]);
        }
      } catch (e) {
        // Ignore audio playback errors if page not yet interacted with
      }
    }

    testAlarm() {
      const prefs = this.storage.prefs;
      this._playBurst(prefs.alarmTone, prefs.alarmVolume);
    }

    startAlarmLoop() {
      this.stopAlarm();
      this.isRinging = true;
      const prefs = this.storage.prefs;
      this._playBurst(prefs.alarmTone, prefs.alarmVolume);
      this.alarmInterval = setInterval(() => {
        if (!this.isRinging) return;
        this._playBurst(this.storage.prefs.alarmTone, this.storage.prefs.alarmVolume);
      }, 2200);
    }

    stopAlarm() {
      this.isRinging = false;
      if (this.alarmInterval) {
        clearInterval(this.alarmInterval);
        this.alarmInterval = null;
      }
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        try { navigator.vibrate(0); } catch (e) {}
      }
    }

    async sendSystemNotification(title, body, tag = 'session-complete') {
      if (!this.storage.prefs.notificationsEnabled) return false;
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;

      const options = {
        body,
        tag,
        renotify: true,
        requireInteraction: true,
        vibrate: [300, 150, 300, 150, 450],
        icon: './assets/icons/icon-192.png',
        badge: './assets/icons/icon-192.png'
      };

      try {
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg && typeof reg.showNotification === 'function') {
            await reg.showNotification(title, options);
            return true;
          }
        }
      } catch (e) {
        // Fallback to window Notification
      }

      try {
        new Notification(title, options);
        return true;
      } catch (e) {
        return false;
      }
    }

    /**
     * Screen Wake Lock API (keeps screen awake while active if user opts in).
     */
    async requestWakeLock() {
      if (!this.storage.prefs.wakeLockEnabled) return false;
      if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return false;
      if (document.visibilityState !== 'visible') return false;
      try {
        if (this.wakeLockSentinel) return true;
        this.wakeLockSentinel = await navigator.wakeLock.request('screen');
        this.wakeLockSentinel.addEventListener('release', () => {
          this.wakeLockSentinel = null;
        });
        return true;
      } catch (e) {
        return false;
      }
    }

    async releaseWakeLock() {
      try {
        if (this.wakeLockSentinel) {
          await this.wakeLockSentinel.release();
          this.wakeLockSentinel = null;
        }
      } catch (e) {
        this.wakeLockSentinel = null;
      }
    }
  }

  global.NotificationAlarmManager = NotificationAlarmManager;
})(typeof window !== 'undefined' ? window : globalThis);
