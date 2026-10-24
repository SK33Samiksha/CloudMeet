# CloudMeet — Connect. Collaborate. Anywhere.

CloudMeet is an MCA Cloud Computing Lab prototype: a small video-meeting web app
built with React + Vite, Node.js/Express, Socket.IO and WebRTC.

## How it works (architecture)

```
 Laptop 1 (host)                                   Laptop 2
 ┌───────────────────────────────┐                ┌──────────────┐
 │ Browser (React app)           │                │ Browser      │
 │   ▲ https://HOST_IP:5173      │◄── https ──────┤ (React app)  │
 │ Vite dev server (HTTPS)       │                └──────┬───────┘
 │   │ forwards /api, /socket.io │                       │
 │   ▼                           │                       │
 │ Node/Express + Socket.IO :5000│  signalling, chat,    │
 │   users.json, recordings/     │  people list          │
 └───────────────────────────────┘                       │
        ▲                                                │
        └──────── WebRTC audio/video (peer-to-peer) ─────┘
```

- **Socket.IO** carries signalling (offers/answers/ICE candidates), chat,
  join/leave events, mic/camera status and the recording indicator.
- **WebRTC** carries the audio/video directly between browsers (mesh: every
  participant connects to every other participant — fine for 4–6 people).
- Each participant is identified by their **socket ID**, used everywhere: in
  Socket.IO events, in the peer-connection list, and as the React key of the tile.

## Run it (Windows, two PowerShell terminals on the HOST laptop)

### 1. Backend — terminal 1

```powershell
cd CloudMeet\backend
npm install
npm run dev
```

### 2. Frontend — terminal 2

```powershell
cd CloudMeet\frontend
npm install
npm run dev
```

Vite prints a **Network** address such as `https://192.168.1.5:5173/`.
That is the address both laptops use.

> **Why HTTPS?** Browsers only allow the camera, microphone and screen sharing
> on `https://` pages or on `http://localhost`. The second laptop opening
> `http://HOST_IP:5173` gets **no camera and no microphone**. `npm run dev` now
> serves HTTPS with a self-signed certificate and forwards `/api` and
> `/socket.io` to the backend, so only port 5173 needs to be reachable.

`frontend/.env` should have `VITE_SIGNALING_URL` and `VITE_API_URL` **empty**
(the browser then uses the same address it opened).

## Test on two laptops

1. Connect both laptops to the **same Wi-Fi** (college Wi-Fi sometimes blocks
   laptop-to-laptop traffic; a phone hotspot is a good fallback).
2. On the host laptop find its IP: `ipconfig` → "IPv4 Address".
3. The first time, Windows Firewall may ask about Node.js — allow it on
   **Private networks**. Make sure the Wi-Fi is set as a *Private* network.
4. On **both** laptops open `https://HOST_IP:5173` in Chrome or Edge.
   You will see a "Your connection is not private" warning because the
   certificate is self-signed: click **Advanced → Proceed**. (Use the IP
   address on the host laptop too, not localhost, so both use the same address.)
5. Sign up / sign in on each laptop (use a different account on each).
6. Laptop 1: **Create meeting**. Copy the meeting code.
7. Laptop 2: enter the code → **Join meeting**. Allow camera and microphone.
8. Check:
   - both laptops show 2 tiles with names, and the count says 2;
   - **Stop video** → the other laptop shows your initials;
   - **Mute** → the other laptop shows a muted icon and the People panel updates;
   - **Chat** messages appear on both;
   - **Share screen** → the other laptop sees it, labelled "Presenting";
     **Stop sharing** returns to the camera;
   - Host only: **Record** → laptop 2 sees "This meeting is being recorded";
     **Stop recording** → the video appears under **Recordings** for any
     signed-in account;
   - Laptop 2 **Leave** → its tile disappears on laptop 1.
   - Host: click the **link icon** next to the meeting code to copy an invite
     link. Opening it on another laptop fills in the code automatically.
   - **Attendance** and **Profile** pages on the home screen.
   - A third account that did not join: **Recordings → Missed a meeting?** →
     enter the meeting code → the recording appears and plays.

If video does not connect (tile says "Video connection failed"), the network is
blocking direct connections. Try a phone hotspot, or configure a TURN relay
(see `frontend/.env.example`). A TURN server may cost money if hosted in the cloud.

`npm run dev:http` starts the old plain-HTTP mode (camera only works on the host
via `http://localhost:5173`).

## Feature status (honest)

| Feature | Status |
|---|---|
| Sign up / sign in / sign out (scrypt-hashed passwords, signed token) | Works — `backend/data/users.json` |
| Profile settings: change name, change password | Works |
| Create meeting (server-generated unique code, optional title) | Works |
| Join by code or **invite link** (`https://HOST_IP:5173/?room=CODE`) | Works; wrong codes show an error |
| One tile per participant, names, initials when camera off, "Connecting…" status | Works |
| Grid adjusts to number of people | Works |
| Audio/video between laptops (WebRTC mesh, STUN) | Works on the same network; strict networks need TURN |
| Mic / camera controls, status shown to others | Works |
| People panel (count, host, mic/camera, connection) | Works |
| Real-time chat, saved with the meeting (late joiners see earlier messages) | Works — `backend/data/meetings.json` |
| Screen sharing to everyone, stop sharing | Works |
| Host-only recording, visible "being recorded" banner | Works (records in the host's browser) |
| Recording library: the host, everyone who attended, and anyone who enters the meeting code (e.g. students who missed the lecture) can watch; only the host can delete and see **who watched** (name and date) | Works — files in `backend/data/recordings/` |
| Attendance history per account, on any device | Works — saved in `backend/data/meetings.json` |
| Google Cloud SQL (MySQL) | **Not implemented yet** (JSON files use the same tables/fields) |
| Google Cloud Storage for recordings | **Not implemented yet** |
| Deployment to Google Compute Engine, SFU media server | **Not implemented yet** |

### Where data is saved (local prototype)

| File | Matches report table |
|---|---|
| `backend/data/users.json` | Users |
| `backend/data/meetings.json` (meetings, `participants`, `viewers`, `messages`) | Meetings, Participants, Messages |
| `backend/data/recordings.json` + `backend/data/recordings/*.webm` | Recordings (+ video files) |

Recordings made before this update (without a saved meeting) stay visible to
every signed-in user.

Note: `better-sqlite3` is listed in `backend/package.json`, but the current
server stores data in JSON files, not SQLite.

## Security notes

- Set a long random `TOKEN_SECRET` in `backend/.env` before any deployment.
- Never commit `.env`, `backend/data/users.json`, `backend/data/meetings.json` or the recordings folder.
- No cloud credentials are stored in this project.
