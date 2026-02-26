# Mobile App Demo Guide

## Prerequisites
- Node 20+
- Xcode (for iOS simulator) and/or Android Studio (for Android emulator)
- Backend services running locally (`appointment-management-service` on port `3001`)

## Install
```bash
cd mobile-app
npm install
```

## API Configuration
`mobile-app/constants/Config.js` now supports emulator-safe defaults and env overrides.

Optional env vars (set before launching Expo):
```bash
EXPO_PUBLIC_API_BASE_URL=http://10.0.2.2:3001
EXPO_PUBLIC_ANDROID_API_BASE_URL=http://10.0.2.2:3001
EXPO_PUBLIC_IOS_API_BASE_URL=http://localhost:3001
EXPO_PUBLIC_API_PORT=3001
EXPO_PUBLIC_PROD_API_BASE_URL=https://api.aloha-readiness.com
```

Recommended defaults:
- Android emulator: `http://10.0.2.2:3001`
- iOS simulator: `http://localhost:3001`

## Run On Emulator
From `mobile-app/`:
```bash
npm run android
```
or
```bash
npm run ios
```

If you prefer Metro UI:
```bash
npm start
```
Then press `a` (Android) or `i` (iOS).

## Demo Checklist
1. Ingest data first (`POST /ingest/excel`) so login accounts exist.
2. Open app and sign in with an ingested account (`demo123`).
3. Verify these screens on emulator:
   - Login
   - Dashboard
   - Appointment list
   - Chat
   - Agent Desk
4. In chat, confirm keyboard + input bar behavior on small screens.
5. In appointment list, confirm filter controls wrap correctly on narrow devices.

## Troubleshooting
- `Network Error` on Android emulator: ensure API URL uses `10.0.2.2`, not `localhost`.
- `Network Error` on iOS simulator: ensure API URL uses `localhost`.
- Empty login accounts: run ingestion and check `GET /auth/accounts`.
- If backend port differs, set `EXPO_PUBLIC_API_PORT` or `EXPO_PUBLIC_API_BASE_URL`.
