# ChronoPlum — Personal Time Tracker & Smart Session Timer (Android PWA)

A mobile-first, installable Progressive Web App (PWA) built with **HTML, CSS, and Vanilla JavaScript** (zero frontend frameworks) featuring two independent timestamp-based timer engines, flexible manual/automatic workflows, exact local midnight rollover, non-overlapping daily analytics, and IndexedDB persistence.

## Brand Palette
- **Primary**: `#421454`
- **Secondary**: `#802C62`
- **Accent**: `#FF5B42`
- **Highlight**: `#FFD749`

## Local Testing
Run any static HTTP server inside this folder (required for Service Worker registration):
```bash
python3 -m http.server 8080
```
Open `http://localhost:8080` in Chrome/Edge.

## GitHub Upload
```bash
git init
git add .
git commit -m "Initial commit: ChronoPlum Personal Time Tracker PWA"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

## Vercel Deployment
1. Go to [vercel.com](https://vercel.com) and click **Add New → Project**.
2. Import your GitHub repository.
3. Leave **Framework Preset** as `Other`, **Build Command** empty, and **Output Directory** as `.`.
4. Click **Deploy**. `vercel.json` is included so `service-worker.js` and `manifest.json` serve with clean cache headers over HTTPS.

## Android Installation (Chrome)
1. Open your deployed Vercel HTTPS URL in **Chrome for Android**.
2. Tap the **Install** button in the app header (or tap Chrome's `⋮` menu → **Add to Home screen / Install app**).
3. Launch **ChronoPlum** from your home screen—it opens in standalone full-screen mode with its own icon and offline app-shell caching.

## Notification Permissions
1. Open **Settings → Enable Notifications** inside the app and tap **Allow** on Android's system prompt.
2. Tap **Test Alarm Sound** once so Android Chrome unlocks the Web Audio engine.

## Known PWA Background Execution Limitations (Honest Platform Constraints)
- **Screen Lock & Browser Closure (Timestamp Accuracy)**: Every timer stores wall-clock timestamps (`segmentStartMs`, `expectedEndMs`) in IndexedDB. When you lock your Android screen with the power button, switch apps, or close Chrome, elapsed time, midnight rollovers, and missed workflow transitions are 100% accurate and reconcile immediately upon returning.
- **Audio While OS Sleeps**: Android Chrome suspends background tabs and does not allow Service Workers to run continuously like a native foreground Android service. Therefore, a PWA cannot guarantee loud audio playback while the phone screen is locked and Chrome is suspended. The app combines **Screen Wake Lock** (when visible), **Web Notifications + Vibration**, and immediate reconciliation + alarm playback when reopened.
- **Fully Powered-Off Device**: No web app can execute timers or play alarms while the device is completely powered down; once powered back on and opened, timestamps still reconcile accurately.
