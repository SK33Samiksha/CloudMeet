# CloudMeet — Updated Video Meeting MVP

CloudMeet is a student-project prototype built with React + Vite, Node.js/Express, Socket.IO, and WebRTC.

## Features in this updated version

- **Sign up and sign in:** create an account with your name, email, and password.
- **Persistent local database:** the backend automatically creates `backend/data/cloudmeet.sqlite` and a `users` table on first start.
- **Password security:** passwords are stored as salted scrypt hashes, not plain text.
- **Session token:** successful sign-in returns a signed, seven-day token stored in the browser.
- Create a meeting room or join with a code.
- Browser camera and microphone controls.
- Peer-to-peer WebRTC video for small demo rooms.
- Room chat through Socket.IO.
- Personal attendance history saved in each browser.
- Meeting recording controls and local playback/download library.

## Run locally on Windows

Use two PowerShell terminals. Make sure Node.js is installed.

### 1. Backend — terminal 1

```powershell
cd CloudMeet\backend
npm install
npm run dev
```

The backend runs at `http://localhost:5000`. On first start, it creates the local SQLite database automatically at `backend/data/cloudmeet.sqlite`. You do not need to install MySQL just to test signup/login locally.

### 2. Frontend — terminal 2

```powershell
cd CloudMeet\frontend
npm install
npm run dev
```

Open `http://localhost:5173/`. The sign-in/sign-up screen should appear first. Create an account, then sign in. Keep the backend terminal running while using the website.

If the website was already running before you extracted this updated ZIP, stop the old frontend and backend with `Ctrl+C`, extract this ZIP to a new folder, then run the commands above from the new folder. Do not overwrite your only copy of the old project.

## Database notes

- Local account data is saved in `backend/data/cloudmeet.sqlite` and remains after restarting the backend.
- Keep the database file private; it contains password hashes and account data.
- The current account database is **local SQLite**, not Google Cloud SQL. Cloud SQL integration and cloud deployment still need to be configured separately.
- If you delete `backend/data/cloudmeet.sqlite`, the local accounts in that file will be deleted.
- Set a long random `TOKEN_SECRET` in a backend `.env` file before any deployment beyond a local demo. Never commit `.env` or database files to Git.

## Important limitations

- Attendance and recording files are still saved in each browser only. They are not shared between accounts/devices and are not stored in Google Cloud Storage.
- Meeting rooms and signalling are held in backend memory and are lost when the backend restarts.
- Screen sharing currently previews locally; it is not broadcast to other participants.
- WebRTC uses a public STUN server only. Some networks need a TURN relay. Mesh calling is intended for a small demo, not large rooms.
- This is an academic prototype, not production-ready authentication or conferencing infrastructure. Use HTTPS, proper rate limiting, secret management, authorization checks, and a production database before public deployment.
