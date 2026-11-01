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

## Cloud deployment (Google Cloud)

```
 Any browser (Wi-Fi / mobile data)
        │ https://34-100-229-5.sslip.io
        ▼
 Compute Engine VM "cloudmeet-vm" (e2-small, asia-south1, static IP 34.100.229.5)
   Caddy  :443  — HTTPS certificate (Let's Encrypt), serves the React build,
                  forwards /api and /socket.io to the backend
   Node   :5000 — Express + Socket.IO backend (systemd service "cloudmeet")
   coturn :3478 — TURN relay for networks that block direct WebRTC
        │
        ├── Cloud Storage bucket — recording videos (GCS_BUCKET)
        └── Cloud SQL (MySQL)    — users, meetings, attendance, chat, recording details
                                   (instance cloudmeet-mysql, Yogita's project)
```

Update the VM after pushing new code:

```bash
cd ~/CloudMeet && git pull
cd backend && npm install && sudo systemctl restart cloudmeet
cd ../frontend && npm install && npm run build && sudo cp -r dist/* /var/www/cloudmeet/
curl -s https://34-100-229-5.sslip.io/health
```

Cloud Storage for recordings:
1. Create a bucket (region `asia-south1`, Standard, public access prevention on).
2. Give the VM's service account the **Storage Object Admin** role on the bucket.
3. The VM's access scopes must allow Cloud Storage read/write.
4. Add `GCS_BUCKET=<bucket-name>` to `backend/.env` and restart the backend.
   `/health` then shows `"recordings":"cloud-storage"`.

Cloud SQL (MySQL) for application data:
1. Create the tables once: `mysql -h <DB_IP> -u cloudmeet_app -p cloudmeet < backend/db/schema.sql`.
2. In Cloud SQL → Connections → Authorized networks, allow only the VM's IP (`34.100.229.5/32`).
3. Add `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` (and `DB_SSL=true`) to `backend/.env`,
   then restart. `/health` then shows `"database":"cloud-sql"`.

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
| Waiting room: guests with the code wait outside until the host presses **Admit** (or **Deny**); the host can also **remove** someone later | Works (version 2) — see "Meeting access and recording privacy" below |
| Invite-only meetings: only the e-mail addresses the host lists may even ask to join | Works (version 2) |
| Recording library: the host and the people the host let in can watch; someone who only knows the code must send a request that the host **approves**; only the host can delete and see **who watched** (name and date) | Works (version 2) — files in `backend/data/recordings/` or the bucket |
| Recordings delete themselves after `RECORDING_RETENTION_DAYS` (default 30) | Works (version 2) — hourly clean-up job + optional bucket lifecycle rule |
| Click a shared screen (or the expand button, or double-click any tile) to view it full screen | Works (version 2) |
| Attendance history per account, on any device | Works — saved in `backend/data/meetings.json` |
| Google Cloud SQL (MySQL) | Works when `DB_HOST` is set — connection `backend/db.js`, queries `backend/store.js`, schema `backend/db/schema.sql`; JSON files otherwise |
| Google Cloud Storage for recordings | Works when `GCS_BUCKET` is set (falls back to local disk) |
| Deployment on Google Compute Engine with HTTPS (Caddy) and TURN (coturn) | Works — https://34-100-229-5.sslip.io |
| SFU media server (VM 2) | Not implemented — mesh is enough for 4–6 people |

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

## Meeting access and recording privacy (version 2)

**Who can enter a meeting**

1. The host (the account that created it) always enters.
2. Everyone else must be signed in. When they enter a valid code they only reach a
   *waiting room*. The server does not connect them to the meeting (no video,
   audio, chat or signalling) until the host presses **Admit**.
3. When creating a meeting the host chooses:
   - **Anyone with the code, after I approve them**, or
   - **Invite only**: the host types e-mail addresses; people not on the list are
     refused even before the waiting room.
4. People the host admitted can reconnect after a refresh without asking again.
   People the host removes must ask again.

**Who can watch a recording**

- The host, and people who were admitted to that meeting.
- Anyone else: entering the meeting code only sends a *request*. The host sees it
  on the Recordings page and presses **Approve** or **Decline**. Until then the
  person cannot list or stream the recording (the server checks on every request).

**Auto-delete of recordings**

- Each recording gets an expiry date: `RECORDING_RETENTION_DAYS` after it was made
  (default 30, set it to 7 for a week, `0` keeps recordings forever).
- The backend checks every hour and deletes expired videos (bucket object and
  database row). The recording card shows the date it will be deleted.
- Safety net: add a lifecycle rule to the bucket so Google deletes anything that
  is still there one day later:

```bash
gcloud storage buckets update gs://YOUR_BUCKET --lifecycle-file=backend/gcs-lifecycle.json
# also make sure the bucket can never be made public:
gcloud storage buckets update gs://YOUR_BUCKET --public-access-prevention
```

  (`backend/gcs-lifecycle.json` deletes objects older than 31 days. Change the
  number if you change `RECORDING_RETENTION_DAYS`.)

**Upgrading the deployed VM**

```bash
cd ~/CloudMeet && git pull
cd backend && npm install            # nothing new, safe to run
# optional: add RECORDING_RETENTION_DAYS=30 to backend/.env
cd ../frontend && npm install && npm run build   # same build step as before
sudo systemctl restart cloudmeet
```

The first start upgrades the Cloud SQL database automatically (adds the columns
`meetings.access_type`, `meetings.invited_emails`, `recordings.expires_at` and
the table `recording_requests`). If the log says it could not, run
`backend/db/migration_v2.sql` once with a user that may alter tables.
Recordings made before the upgrade have no expiry date and are kept until the
host deletes them (the optional last line of `migration_v2.sql` gives them one).

## Security notes

- Set a long random `TOKEN_SECRET` in `backend/.env` before any deployment.
- Never commit `.env`, `backend/data/users.json`, `backend/data/meetings.json` or the recordings folder.
- No cloud credentials are stored in this project.
