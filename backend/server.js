// Load backend/.env for local development (on the VM, systemd provides it).
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import http from 'node:http'
import { Server } from 'socket.io'
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac
} from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import multer from 'multer'
import { createStore, DuplicateError } from './store.js'
import {
  cloudStorageEnabled,
  cloudStorageBucket,
  uploadToCloud,
  streamFromCloud,
  deleteFromCloud
} from './cloudStorage.js'

const app = express()
const server = http.createServer(app)
const PORT = Number(process.env.PORT || 5000)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, 'data')
const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings')

mkdirSync(RECORDINGS_DIR, { recursive: true })

// Users, meetings, attendance, chat and recording details are stored in
// Cloud SQL (MySQL) when DB_HOST is set, otherwise in JSON files.
// See store.js. "store" is created when the server starts (bottom of file).
let store

// Allow the local frontend and other laptops on the same private network.
// You can override this using CLIENT_ORIGIN in your backend .env file.
const configuredOrigins = process.env.CLIENT_ORIGIN
  ? process.env.CLIENT_ORIGIN.split(',').map(value => value.trim())
  : [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://10.217.72.119:5173'
    ]

function isAllowedOrigin(origin) {
  // Requests without an Origin header, such as direct health checks.
  if (!origin) return true

  if (configuredOrigins.includes(origin)) return true

  // Development support for other private-network IP addresses.
  // This lets you use the frontend from another laptop on the same Wi-Fi.
  try {
    const url = new URL(origin)

    // Vite runs on port 5173. HTTPS is needed so that the second laptop
    // is allowed to use its camera and microphone.
    if (!['http:', 'https:'].includes(url.protocol) || url.port !== '5173') {
      return false
    }

    const hostname = url.hostname

    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname)
    )
  } catch {
    return false
  }
}

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      callback(null, true)
    } else {
      callback(new Error(`CORS blocked this origin: ${origin}`))
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}

app.use(cors(corsOptions))
app.use(express.json({ limit: '1mb' }))

const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) {
        callback(null, true)
      } else {
        callback(new Error(`Socket.IO CORS blocked this origin: ${origin}`))
      }
    },
    methods: ['GET', 'POST'],
    credentials: true
  }
})

const TOKEN_SECRET = process.env.TOKEN_SECRET ||
  'change-this-secret-before-deploying-cloudmeet'

if (!process.env.TOKEN_SECRET) {
  console.warn('Warning: Set TOKEN_SECRET before deployment.')
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password, storedHash) {
  const [salt, hash] = String(storedHash || '').split(':')

  if (!salt || !hash) return false

  const expected = Buffer.from(hash, 'hex')
  const actual = scryptSync(password, salt, 64)

  return expected.length === actual.length &&
    timingSafeEqual(actual, expected)
}

function createToken(user) {
  const payload = Buffer.from(JSON.stringify({
    id: user.id,
    email: user.email,
    name: user.name,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  })).toString('base64url')

  const signature = createHmac('sha256', TOKEN_SECRET)
    .update(payload)
    .digest('base64url')

  return `${payload}.${signature}`
}

// A <video src="..."> tag cannot send an Authorization header, so the
// recording playback route also accepts the token as ?token=...
function authenticateWithQueryToken(req, res, next) {
  if (!req.headers.authorization && typeof req.query.token === 'string') {
    req.headers.authorization = `Bearer ${req.query.token}`
  }
  return authenticate(req, res, next)
}

// Checks a sign-in token. Returns { user } or { error }.
// Used by the REST API and by Socket.IO when someone joins a meeting.
function verifyToken(token) {
  const [payload, signature] = String(token || '').split('.')

  if (!payload || !signature) {
    return { error: 'Please sign in.' }
  }

  const expected = createHmac('sha256', TOKEN_SECRET)
    .update(payload)
    .digest()

  const actual = Buffer.from(signature, 'base64url')

  if (
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    return { error: 'Invalid session. Please sign in again.' }
  }

  try {
    const user = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    )

    if (!user.id || !user.exp || user.exp < Date.now()) {
      return { error: 'Session expired. Please sign in again.' }
    }

    return { user }
  } catch {
    return { error: 'Invalid session. Please sign in again.' }
  }
}

function authenticate(req, res, next) {
  const token = (req.headers.authorization || '')
    .replace(/^Bearer\s+/i, '')

  const { user, error } = verifyToken(token)
  if (error) return res.status(401).json({ error })

  req.user = user
  next()
}

function cleanCode(value) {
  return typeof value === 'string'
    ? value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)
    : ''
}

const MAX_CHAT_HISTORY = 100

// Recordings are deleted automatically this many days after they are made.
// Set RECORDING_RETENTION_DAYS=0 in backend/.env to keep them forever.
const configuredDays = Number(process.env.RECORDING_RETENTION_DAYS)
const RETENTION_DAYS = process.env.RECORDING_RETENTION_DAYS?.trim() && Number.isFinite(configuredDays)
  ? configuredDays
  : 30

function recordingExpiry(from = new Date()) {
  return RETENTION_DAYS > 0
    ? new Date(from.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000)
    : null
}

// The host types the guest list of an invite-only meeting as free text
// ("a@x.com, b@y.com") or the browser sends an array. Returns clean,
// unique, lowercase addresses (at most 50).
function parseInviteEmails(value) {
  const parts = Array.isArray(value)
    ? value
    : typeof value === 'string' ? value.split(/[\s,;]+/) : []

  const emails = parts
    .map(item => String(item).trim().toLowerCase())
    .filter(item => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item))

  return [...new Set(emails)].slice(0, 50)
}

// API health checks
app.get('/', (_req, res) => {
  res.json({ app: 'CloudMeet API', status: 'running' })
})

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    recordings: cloudStorageEnabled ? 'cloud-storage' : 'local-disk',
    database: store?.mode === 'mysql' ? 'cloud-sql' : 'json-files'
  })
})

// SIGN UP
app.post('/api/auth/signup', async (req, res) => {
  const name = typeof req.body?.name === 'string'
    ? req.body.name.trim().slice(0, 80)
    : ''

  const email = typeof req.body?.email === 'string'
    ? req.body.email.trim().toLowerCase()
    : ''

  const password = typeof req.body?.password === 'string'
    ? req.body.password
    : ''

  if (name.length < 2) {
    return res.status(400).json({ error: 'Enter your name.' })
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      error: 'Enter a valid email address.'
    })
  }

  if (password.length < 8) {
    return res.status(400).json({
      error: 'Password must contain at least 8 characters.'
    })
  }

  try {
    const user = await store.createUser({
      name,
      email,
      password_hash: hashPassword(password)
    })

    return res.status(201).json({
      user,
      token: createToken(user)
    })
  } catch (error) {
    if (error instanceof DuplicateError) {
      return res.status(409).json({
        error: 'This account already exists. Please sign in.'
      })
    }
    console.error('Signup failed:', error)
    return res.status(500).json({
      error: 'Could not create the account.'
    })
  }
})

// SIGN IN
app.post('/api/auth/login', async (req, res) => {
  const email = typeof req.body?.email === 'string'
    ? req.body.email.trim().toLowerCase()
    : ''

  const password = typeof req.body?.password === 'string'
    ? req.body.password
    : ''

  try {
    const account = await store.findUserByEmail(email)

    if (!account || !verifyPassword(password, account.password_hash)) {
      return res.status(401).json({
        error: 'Email or password is incorrect.'
      })
    }

    const user = {
      id: account.id,
      name: account.name,
      email: account.email
    }

    return res.json({
      user,
      token: createToken(user)
    })
  } catch (error) {
    console.error('Login failed:', error)
    return res.status(500).json({
      error: 'Could not sign in.'
    })
  }
})

// GET SIGNED-IN ACCOUNT
app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    const account = await store.findUserById(req.user.id)

    if (!account) {
      return res.status(404).json({ error: 'Account not found.' })
    }

    res.json({
      user: {
        id: account.id,
        name: account.name,
        email: account.email
      }
    })
  } catch {
    res.status(500).json({ error: 'Could not load account.' })
  }
})

// UPDATE PROFILE (display name)
app.put('/api/auth/profile', authenticate, async (req, res) => {
  const name = typeof req.body?.name === 'string'
    ? req.body.name.trim().slice(0, 80)
    : ''

  if (name.length < 2) {
    return res.status(400).json({ error: 'Name must have at least 2 characters.' })
  }

  try {
    const user = await store.updateUserName(req.user.id, name)

    if (!user) {
      return res.status(404).json({ error: 'Account not found.' })
    }

    // The token contains the name, so give the browser a fresh token.
    res.json({ user, token: createToken(user) })
  } catch (error) {
    console.error('Profile update failed:', error)
    res.status(500).json({ error: 'Could not update your profile.' })
  }
})

// CHANGE PASSWORD
app.put('/api/auth/password', authenticate, async (req, res) => {
  const currentPassword = typeof req.body?.currentPassword === 'string'
    ? req.body.currentPassword
    : ''
  const newPassword = typeof req.body?.newPassword === 'string'
    ? req.body.newPassword
    : ''

  if (newPassword.length < 8) {
    return res.status(400).json({
      error: 'New password must contain at least 8 characters.'
    })
  }

  try {
    const account = await store.findUserById(req.user.id)

    if (!account) {
      return res.status(404).json({ error: 'Account not found.' })
    }

    if (!verifyPassword(currentPassword, account.password_hash)) {
      return res.status(400).json({ error: 'Current password is incorrect.' })
    }

    await store.updateUserPassword(req.user.id, hashPassword(newPassword))
    res.json({ ok: true })
  } catch (error) {
    console.error('Password change failed:', error)
    res.status(500).json({ error: 'Could not change your password.' })
  }
})

// CREATE A MEETING — the server generates a unique code.
app.post('/api/meetings', authenticate, async (req, res) => {
  const title = typeof req.body?.title === 'string' && req.body.title.trim()
    ? req.body.title.trim().slice(0, 80)
    : 'Team meeting'

  // "ask": anyone signed in who has the code can ask to join, and the host
  // lets them in. "invite": only the e-mail addresses the host lists can ask.
  const accessType = req.body?.accessType === 'invite' ? 'invite' : 'ask'
  const invitedEmails = accessType === 'invite'
    ? parseInviteEmails(req.body?.invitedEmails)
    : []

  if (accessType === 'invite' && invitedEmails.length === 0) {
    return res.status(400).json({
      error: 'Add at least one valid email address for an invite-only meeting.'
    })
  }

  try {
    const meeting = await store.createMeeting({
      title,
      host_user_id: req.user.id,
      host_name: req.user.name,
      access_type: accessType,
      invited_emails: invitedEmails
    })
    res.status(201).json({
      meeting: {
        id: meeting.id,
        title: meeting.title,
        hostName: meeting.host_name,
        accessType: meeting.access_type
      }
    })
  } catch (error) {
    console.error('Meeting create failed:', error)
    res.status(500).json({ error: 'Could not create the meeting.' })
  }
})

// CHECK A MEETING CODE (used by the join form and invite links)
app.get('/api/meetings/:code', authenticate, async (req, res) => {
  try {
    const meeting = await store.getMeeting(cleanCode(req.params.code))

    if (!meeting) {
      return res.status(404).json({
        error: 'No meeting found with this code. Check the code and try again.'
      })
    }

    // Invite-only: tell people who are not on the guest list right away.
    const isHost = meeting.host_user_id === req.user.id
    const email = String(req.user.email || '').toLowerCase()
    if (
      !isHost &&
      meeting.access_type === 'invite' &&
      !(meeting.invited_emails || []).includes(email)
    ) {
      return res.status(403).json({
        error: 'This meeting is invite-only and your email address is not on the guest list.'
      })
    }

    res.json({
      meeting: {
        id: meeting.id,
        title: meeting.title,
        hostName: meeting.host_name,
        status: meeting.status,
        accessType: meeting.access_type,
        createdAt: new Date(meeting.created_at).getTime()
      }
    })
  } catch {
    res.status(500).json({ error: 'Could not check the meeting code.' })
  }
})

// MY ATTENDANCE — every time this user joined a meeting (any device).
app.get('/api/attendance', authenticate, async (req, res) => {
  try {
    const records = (await store.listAttendance(req.user.id)).map(record => ({
      id: record.id,
      room: record.room,
      title: record.title,
      name: record.name,
      role: record.isHost ? 'Host' : 'Participant',
      joinedAt: record.joinedAt,
      leftAt: record.leftAt,
      durationMinutes: record.leftAt
        ? Math.max(1, Math.round((record.leftAt - record.joinedAt) / 60000))
        : null,
      participantCount: record.participantCount
    }))

    res.json({ attendance: records })
  } catch (error) {
    console.error('Attendance failed:', error.message)
    res.status(500).json({ error: 'Could not load attendance.' })
  }
})

// RECORDING STORAGE
const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, RECORDINGS_DIR)
  },
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase()

    callback(
      null,
      `${Date.now()}-${randomBytes(8).toString('hex')}${extension}`
    )
  }
})

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname || '').toLowerCase()
    if (
      file.mimetype.startsWith('video/') ||
      ['.webm', '.mp4'].includes(extension)
    ) {
      callback(null, true)
    } else {
      console.warn('Rejected upload type:', file.mimetype, file.originalname)
      callback(new Error('Only video files are allowed.'))
    }
  }
})

// UPLOAD A RECORDING
app.post(
  '/api/recordings',
  authenticate,
  upload.single('video'),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: 'Select a video file to upload.'
      })
    }

    const title = String(req.body?.title || 'Recorded class')
      .trim()
      .slice(0, 120)

    const room = cleanCode(String(req.body?.room || ''))

    const durationSeconds = Math.max(
      0,
      Math.min(24 * 60 * 60, Math.round(Number(req.body?.durationSeconds) || 0))
    )

    try {
      // Only the meeting's host may upload its recording.
      const meeting = await store.getMeeting(room)
      if (meeting && meeting.host_user_id !== req.user.id) {
        try { unlinkSync(req.file.path) } catch {}
        return res.status(403).json({
          error: 'Only the host of this meeting can save its recording.'
        })
      }
      // In the database every recording must belong to a saved meeting.
      if (!meeting && store.mode === 'mysql') {
        try { unlinkSync(req.file.path) } catch {}
        return res.status(400).json({
          error: 'This meeting was not found, so the recording could not be saved.'
        })
      }

      const recording = {
        id: randomBytes(12).toString('hex'),
        title,
        room,
        filename: req.file.filename,
        size: req.file.size,
        duration_seconds: durationSeconds,
        created_at: new Date().toISOString(),
        host_id: req.user.id,
        host_name: req.user.name,
        storage: 'local',
        // The video is deleted automatically after RECORDING_RETENTION_DAYS.
        expires_at: recordingExpiry()?.toISOString() || null
      }

      // Move the video to Google Cloud Storage when a bucket is configured.
      // If the upload fails, keep the local copy so the recording is not lost.
      if (cloudStorageEnabled) {
        const objectName = `recordings/${req.file.filename}`
        try {
          await uploadToCloud(req.file.path, objectName, 'video/webm')
          recording.storage = 'gcs'
          recording.gcs_object = objectName
          try { unlinkSync(req.file.path) } catch {}
        } catch (error) {
          console.error('Cloud Storage upload failed, keeping local copy:', error.message)
        }
      }

      await store.createRecording(recording)

      res.status(201).json({ recording: toPublicRecording(recording) })
    } catch (error) {
      console.error('Recording save failed:', error)
      res.status(500).json({
        error: 'Could not save recording details.'
      })
    }
  }
)

// The field names here match what the React recordings page reads.
function toPublicRecording(recording) {
  return {
    id: recording.id,
    title: recording.title,
    room: recording.room,
    sizeBytes: recording.size,
    durationSeconds: recording.duration_seconds || 0,
    createdAt: new Date(recording.created_at).getTime(),
    hostId: recording.host_id,
    hostName: recording.host_name,
    expiresAt: recording.expires_at ? new Date(recording.expires_at).getTime() : null,
    url: `/api/recordings/${recording.id}/video`
  }
}

// ASK FOR ACCESS TO A MEETING'S RECORDINGS
// Knowing the meeting code is NOT enough. Someone who missed the meeting
// enters the code to send a request; the host of that meeting must approve
// it (see /api/recordings/requests below) before any recording is visible.
// People who were admitted to the meeting already have access.
app.post('/api/recordings/access', authenticate, async (req, res) => {
  const code = cleanCode(req.body?.code)

  if (!code) {
    return res.status(400).json({ error: 'Enter the meeting code.' })
  }

  try {
    const account = await store.findUserById(req.user.id)
    const result = await store.addRecordingRequest(
      code,
      req.user.id,
      account?.name || req.user.name
    )

    if (!result) {
      return res.status(404).json({
        error: 'No meeting found with this code. Check the code and try again.'
      })
    }

    const { meeting, status } = result

    res.json({
      status,
      meeting: { id: meeting.id, title: meeting.title, hostName: meeting.host_name },
      // The number of recordings is only revealed once access is approved.
      recordingCount: status === 'approved'
        ? await store.countRecordingsInRoom(code)
        : undefined
    })
  } catch (error) {
    console.error('Recording access failed:', error)
    res.status(500).json({ error: 'Could not send the request.' })
  }
})

// REQUESTS WAITING FOR THE HOST (only for meetings this user hosts)
app.get('/api/recordings/requests', authenticate, async (req, res) => {
  try {
    const requests = (await store.listRecordingRequests(req.user.id)).map(item => ({
      meetingId: item.meeting_id,
      title: item.title,
      userId: Number(item.user_id),
      name: item.name,
      requestedAt: new Date(item.requested_at).getTime()
    }))

    res.json({ requests })
  } catch (error) {
    console.error('Request list failed:', error.message)
    res.status(500).json({ error: 'Could not load access requests.' })
  }
})

// HOST APPROVES OR DECLINES A REQUEST
app.post('/api/recordings/requests/:code/:userId/:decision', authenticate, async (req, res) => {
  const code = cleanCode(req.params.code)
  const userId = Number(req.params.userId)
  const decision = req.params.decision

  if (!code || !Number.isInteger(userId) || !['approve', 'deny'].includes(decision)) {
    return res.status(400).json({ error: 'Invalid request.' })
  }

  try {
    const done = await store.resolveRecordingRequest(
      code,
      userId,
      req.user.id,
      decision === 'approve'
    )

    if (!done) {
      return res.status(404).json({
        error: 'Request not found, or you are not the host of this meeting.'
      })
    }

    res.json({ ok: true })
  } catch (error) {
    console.error('Resolving request failed:', error)
    res.status(500).json({ error: 'Could not save your decision.' })
  }
})

// LIST RECORDINGS
app.get('/api/recordings', authenticate, async (req, res) => {
  try {
    const visible = []
    for (const recording of await store.listRecordings()) {
      if (await store.canViewRecording(recording, req.user.id)) {
        visible.push({
          ...toPublicRecording(recording),
          // Only the host is told how many people watched.
          viewCount: recording.host_id === req.user.id
            ? recording.view_count || 0
            : undefined
        })
      }
    }

    res.json({ recordings: visible })
  } catch (error) {
    console.error('Recording list failed:', error.message)
    res.status(500).json({
      error: 'Could not load recordings.'
    })
  }
})

// STREAM A RECORDING
app.get('/api/recordings/:id/video', authenticateWithQueryToken, async (req, res) => {
  try {
    const recording = await store.getRecording(req.params.id)

    if (!recording) {
      return res.status(404).json({ error: 'Recording not found.' })
    }

    if (!(await store.canViewRecording(recording, req.user.id))) {
      return res.status(403).json({
        error: 'Only the host and people the host approved can watch this recording.'
      })
    }

    if (recording.storage === 'gcs') {
      if (!cloudStorageEnabled) {
        return res.status(503).json({ error: 'Cloud Storage is not configured on this server.' })
      }
      return await streamFromCloud(recording.gcs_object, req, res)
    }

    const filePath = path.join(RECORDINGS_DIR, recording.filename)

    if (!existsSync(filePath)) {
      return res.status(404).json({ error: 'Video file is missing.' })
    }

    res.sendFile(filePath)
  } catch (error) {
    console.error('Playback failed:', error.message)
    if (res.headersSent) return
    if (error.code === 404) {
      return res.status(404).json({
        error: 'This recording has expired and was deleted.'
      })
    }
    res.status(500).json({
      error: 'Could not play recording.'
    })
  }
})

// SOMEONE PRESSED PLAY — remember their name and the date.
// One entry per person; watching again updates the date.
app.post('/api/recordings/:id/view', authenticate, async (req, res) => {
  try {
    const recording = await store.getRecording(req.params.id)

    if (!recording) {
      return res.status(404).json({ error: 'Recording not found.' })
    }

    if (!(await store.canViewRecording(recording, req.user.id))) {
      return res.status(403).json({ error: 'You cannot watch this recording.' })
    }

    // The host watching their own recording is not counted.
    if (recording.host_id !== req.user.id) {
      const account = await store.findUserById(req.user.id)
      await store.recordView(recording.id, req.user.id, account?.name || req.user.name)
    }

    res.json({ ok: true })
  } catch (error) {
    console.error('Saving view failed:', error)
    res.status(500).json({ error: 'Could not save the view.' })
  }
})

// WHO WATCHED A RECORDING (only the host who recorded it)
app.get('/api/recordings/:id/viewers', authenticate, async (req, res) => {
  try {
    const recording = await store.getRecording(req.params.id)

    if (!recording) {
      return res.status(404).json({ error: 'Recording not found.' })
    }

    if (recording.host_id !== req.user.id) {
      return res.status(403).json({
        error: 'Only the host who recorded this meeting can see who watched it.'
      })
    }

    const viewers = (await store.listViews(recording.id))
      .map(view => ({ name: view.name, watchedAt: new Date(view.watched_at).getTime() }))
      .sort((a, b) => b.watchedAt - a.watchedAt)

    res.json({ viewers })
  } catch (error) {
    console.error('Viewer list failed:', error.message)
    res.status(500).json({ error: 'Could not load viewers.' })
  }
})

// Remove the video file itself (from Cloud Storage or from the server disk).
async function deleteRecordingFiles(recording) {
  if (recording.storage === 'gcs' && cloudStorageEnabled) {
    await deleteFromCloud(recording.gcs_object)
  } else {
    const filePath = path.join(RECORDINGS_DIR, recording.filename)
    if (existsSync(filePath)) unlinkSync(filePath)
  }
}

// AUTOMATIC CLEAN-UP: delete recordings whose expiry date has passed.
// Runs a little after start-up and then every hour. A Cloud Storage
// "lifecycle rule" (see README) is a second safety net.
async function removeExpiredRecordings() {
  try {
    for (const recording of await store.listExpiredRecordings(new Date())) {
      // Cannot reach the bucket from here: leave the record for the next run.
      if (recording.storage === 'gcs' && !cloudStorageEnabled) continue

      try {
        await deleteRecordingFiles(recording)
        await store.deleteRecording(recording.id)
        console.log(`Deleted expired recording ${recording.id} ("${recording.title}")`)
      } catch (error) {
        console.error(`Could not delete expired recording ${recording.id}:`, error.message)
      }
    }
  } catch (error) {
    console.error('Expired recording check failed:', error.message)
  }
}

// DELETE A RECORDING (only the host who uploaded it)
app.delete('/api/recordings/:id', authenticate, async (req, res) => {
  try {
    const recording = await store.getRecording(req.params.id)

    if (!recording) {
      return res.status(404).json({ error: 'Recording not found.' })
    }

    if (recording.host_id !== req.user.id) {
      return res.status(403).json({
        error: 'Only the host who recorded this meeting can delete it.'
      })
    }

    await deleteRecordingFiles(recording)
    await store.deleteRecording(recording.id)

    res.json({ ok: true })
  } catch (error) {
    console.error('Recording delete failed:', error)
    res.status(500).json({ error: 'Could not delete recording.' })
  }
})

// SOCKET.IO: MEETING CHAT AND WEBRTC SIGNALING
// roomUsers:    room code -> Map(socket.id -> participant details)
// roomMeta:     room code -> { hostId, recording, title, accessType }
// roomPending:  room code -> Map(socket.id -> { name, userId })  (waiting room)
// roomAdmitted: room code -> Set(user IDs the host already let in)
// The socket.id is the participant ID everywhere: in Socket.IO events,
// in the browser's peer-connection list, and as the React key of each tile.
// The signed-in account (user ID) is used for attendance and permissions.
// Live room state is kept in memory; attendance and chat are saved by "store".
//
// WHO MAY ENTER A MEETING
//  1. The host (the account that created the meeting) always enters.
//  2. Everyone else must be signed in AND approved by the host. A guest who
//     enters a valid code only reaches the WAITING ROOM: the server does not
//     put them in the Socket.IO room, so they cannot see, hear, chat with or
//     send signals to anyone until the host presses "Admit".
//  3. In an invite-only meeting the guest's e-mail must also be on the
//     host's list, otherwise they are refused before reaching the waiting room.
const roomUsers = new Map()
const roomMeta = new Map()
const roomPending = new Map()
const roomAdmitted = new Map()
const MAX_WAITING_PER_ROOM = 30

function publicUser(id, user) {
  return {
    id,
    name: user.name,
    micOn: user.micOn,
    cameraOn: user.cameraOn,
    screenSharing: user.screenSharing,
    isHost: user.isHost
  }
}

function roomState(room) {
  const meta = roomMeta.get(room) || {}
  return {
    hostId: meta.hostId || null,
    recording: Boolean(meta.recording),
    title: meta.title || 'Team meeting',
    accessType: meta.accessType || 'ask'
  }
}

function pendingList(room) {
  return [...(roomPending.get(room) || new Map()).entries()]
    .map(([id, person]) => ({ id, name: person.name }))
}

// Tell the host (if they are in the meeting) who is waiting outside.
function sendPendingToHost(room) {
  const hostSocketId = roomMeta.get(room)?.hostId
  if (hostSocketId) io.to(hostSocketId).emit('join-requests', pendingList(room))
}

// Remove a socket from the waiting room (admitted, denied, cancelled or gone).
function stopWaiting(socket) {
  const room = socket.data.waitingRoom
  if (!room) return
  socket.data.waitingRoom = null
  socket.data.pendingJoin = null

  const pending = roomPending.get(room)
  if (pending) {
    pending.delete(socket.id)
    if (pending.size === 0) roomPending.delete(room)
  }
  sendPendingToHost(room)
}

// The room this socket hosts right now, or null if it is not the host.
function hostedRoom(socket) {
  const room = socket.data.room
  const meta = room && roomMeta.get(room)
  return meta && meta.hostId === socket.id ? room : null
}

// Put a socket into the live meeting (host, or a guest the host admitted).
async function enterRoom(socket, { room, meeting, account, name, payload }) {
  if (!socket.connected) return

  const users = roomUsers.get(room) || new Map()
  const meta = roomMeta.get(room) || { hostId: null, recording: false }
  meta.title = meeting.title
  meta.accessType = meeting.access_type || 'ask'

  // The account that created the meeting is the host. If the host
  // reconnects (new socket.id), they become host again.
  const isHostAccount = meeting.host_user_id === account.id
  if (isHostAccount) meta.hostId = socket.id
  roomMeta.set(room, meta)

  // Remember that this person was let in, so a page refresh or a short
  // network drop does not send them back to the waiting room.
  if (!isHostAccount) {
    const admitted = roomAdmitted.get(room) || new Set()
    admitted.add(account.id)
    roomAdmitted.set(room, admitted)
  }

  const existingUsers = [...users.entries()].map(
    ([id, user]) => publicUser(id, user)
  )

  socket.join(room)
  socket.data.room = room
  socket.data.name = name
  socket.data.userId = account.id

  const user = {
    name,
    userId: account.id,
    micOn: payload?.micOn !== false,
    cameraOn: payload?.cameraOn !== false,
    screenSharing: false,
    isHost: isHostAccount
  }

  users.set(socket.id, user)
  roomUsers.set(room, users)

  const attendanceId = randomBytes(8).toString('hex')
  socket.data.attendanceId = attendanceId

  socket.emit('room-state', { ...roomState(room), selfId: socket.id })
  socket.emit('room-users', existingUsers)
  socket.to(room).emit('user-joined', publicUser(socket.id, user))

  // The host also receives the list of people already waiting.
  if (isHostAccount) socket.emit('join-requests', pendingList(room))

  // Save attendance (one entry per join, closed when they leave)
  // and send this meeting's earlier chat messages.
  try {
    await store.addParticipant(room, {
      id: attendanceId,
      user_id: account.id,
      name,
      joined_at: new Date()
    })
  } catch (saveError) {
    console.error('Could not save attendance:', saveError.message)
  }

  try {
    const history = (await store.getRecentMessages(room, MAX_CHAT_HISTORY)).map(message => ({
      id: message.id,
      senderId: null,
      name: message.name,
      message: message.message_text,
      time: new Date(message.sent_at).getTime()
    }))
    socket.emit('chat-history', history)
  } catch (historyError) {
    console.error('Could not load chat history:', historyError.message)
    socket.emit('chat-history', [])
  }
}

function leaveRoom(socket, room) {
  if (!room) return

  socket.leave(room)

  const users = roomUsers.get(room)
  let roomIsEmpty = false

  if (users) {
    users.delete(socket.id)

    if (users.size === 0) {
      roomUsers.delete(room)
      roomMeta.delete(room)
      roomAdmitted.delete(room)
      roomIsEmpty = true
    } else {
      roomUsers.set(room, users)
    }
  }

  // Close this person's attendance entry.
  const attendanceId = socket.data.attendanceId
  socket.data.attendanceId = null
  if (attendanceId) {
    store.closeParticipant(room, attendanceId, roomIsEmpty)
      .catch(saveError => console.error('Could not save leave time:', saveError.message))
  }

  // If the host leaves while recording, turn the indicator off.
  const meta = roomMeta.get(room)
  if (meta && meta.hostId === socket.id) {
    meta.hostId = null
    if (meta.recording) meta.recording = false
    socket.to(room).emit('room-state', roomState(room))
  }

  socket.to(room).emit('user-left', socket.id)

  if (socket.data.room === room) {
    socket.data.room = null
  }
}

io.on('connection', socket => {
  socket.on('join-room', async payload => {
    const room = cleanCode(payload?.room)

    const name = typeof payload?.name === 'string'
      ? payload.name.trim().slice(0, 32) || 'Guest'
      : 'Guest'

    if (!room) {
      return socket.emit('join-error', { error: 'Enter a meeting code.' })
    }

    // Only signed-in users may join, so attendance belongs to an account.
    const { user: account, error } = verifyToken(payload?.token)
    if (error) {
      return socket.emit('join-error', { error, signOut: true })
    }

    let meeting
    try {
      meeting = await store.getMeeting(room)
    } catch (lookupError) {
      console.error('Meeting lookup failed:', lookupError.message)
      return socket.emit('join-error', { error: 'Meeting data is unavailable. Check the backend.' })
    }

    if (!meeting) {
      return socket.emit('join-error', {
        error: `No meeting found with code ${room}. Check the code and try again.`
      })
    }

    if (!socket.connected) return

    if (socket.data.room) leaveRoom(socket, socket.data.room)
    stopWaiting(socket)

    const isHostAccount = meeting.host_user_id === account.id

    if (!isHostAccount) {
      // Invite-only meetings: the guest's e-mail must be on the host's list.
      const email = String(account.email || '').toLowerCase()
      if (meeting.access_type === 'invite' && !(meeting.invited_emails || []).includes(email)) {
        return socket.emit('join-error', {
          error: 'This meeting is invite-only and your email address is not on the guest list.'
        })
      }

      // Everyone else needs the host's approval (unless already admitted).
      if (!roomAdmitted.get(room)?.has(account.id)) {
        const pending = roomPending.get(room) || new Map()
        if (!pending.has(socket.id) && pending.size >= MAX_WAITING_PER_ROOM) {
          return socket.emit('join-error', {
            error: 'Too many people are waiting to join this meeting. Try again later.'
          })
        }
        pending.set(socket.id, { name, userId: account.id })
        roomPending.set(room, pending)
        socket.data.waitingRoom = room
        socket.data.pendingJoin = { meeting, account, name, payload }

        socket.emit('waiting-for-host', {
          title: meeting.title,
          hostName: meeting.host_name
        })
        sendPendingToHost(room)
        return
      }
    }

    await enterRoom(socket, { room, meeting, account, name, payload })
  })

  // ---- host decisions about the waiting room ----
  socket.on('admit-user', async ({ id } = {}) => {
    const room = hostedRoom(socket)
    if (!room || typeof id !== 'string') return

    const target = io.sockets.sockets.get(id)
    const info = target?.data.pendingJoin
    if (!target || !info || target.data.waitingRoom !== room) return

    stopWaiting(target)
    await enterRoom(target, {
      room,
      meeting: info.meeting,
      account: info.account,
      name: info.name,
      payload: info.payload
    })
  })

  socket.on('deny-user', ({ id } = {}) => {
    const room = hostedRoom(socket)
    if (!room || typeof id !== 'string') return

    const target = io.sockets.sockets.get(id)
    if (!target || target.data.waitingRoom !== room) return

    stopWaiting(target)
    target.emit('join-denied')
  })

  // The host can remove someone who is already in the meeting.
  socket.on('remove-user', ({ id } = {}) => {
    const room = hostedRoom(socket)
    if (!room || typeof id !== 'string' || id === socket.id) return

    const target = io.sockets.sockets.get(id)
    if (!target || target.data.room !== room) return

    // Removed people must be approved again if they try to come back.
    roomAdmitted.get(room)?.delete(target.data.userId)
    leaveRoom(target, room)
    target.emit('removed-from-meeting')
  })

  // Microphone / camera / screen-share status, shown to everyone.
  socket.on('media-state', state => {
    const room = socket.data.room
    const user = room && roomUsers.get(room)?.get(socket.id)
    if (!user) return

    if (typeof state?.micOn === 'boolean') user.micOn = state.micOn
    if (typeof state?.cameraOn === 'boolean') user.cameraOn = state.cameraOn
    if (typeof state?.screenSharing === 'boolean') {
      user.screenSharing = state.screenSharing
    }

    socket.to(room).emit('media-state', publicUser(socket.id, user))
  })

  // Only the host may change the recording indicator.
  socket.on('recording-state', ({ recording } = {}) => {
    const room = socket.data.room
    const meta = room && roomMeta.get(room)
    if (!meta || meta.hostId !== socket.id) return

    meta.recording = Boolean(recording)
    io.to(room).emit('room-state', roomState(room))
  })

  // WebRTC signalling is only passed between two people who are both
  // inside the same meeting (so someone in the waiting room cannot use it).
  socket.on('signal', ({ to, data } = {}) => {
    if (typeof to !== 'string' || !data) return

    const room = socket.data.room
    if (!room) return

    const target = io.sockets.sockets.get(to)
    if (!target || target.data.room !== room) return

    target.emit('signal', {
      from: socket.id,
      data
    })
  })

  socket.on('chat-message', ({ room, message } = {}) => {
    const cleanRoom = cleanCode(room)

    const cleanMessage = typeof message === 'string'
      ? message.trim().slice(0, 1000)
      : ''

    if (
      !cleanRoom ||
      !cleanMessage ||
      socket.data.room !== cleanRoom
    ) {
      return
    }

    const chat = {
      id: `${Date.now()}-${socket.id}`,
      // Use the name the server already knows, so nobody can send a
      // message pretending to be someone else.
      senderId: socket.id,
      name: socket.data.name || 'Guest',
      message: cleanMessage,
      time: Date.now()
    }

    io.to(cleanRoom).emit('chat-message', chat)

    // Keep the chat with the meeting (Messages table).
    store.addMessage(cleanRoom, {
      id: chat.id,
      sender_user_id: socket.data.userId,
      name: chat.name,
      message_text: chat.message,
      sent_at: new Date(chat.time)
    }).catch(saveError => console.error('Could not save chat message:', saveError.message))
  })

  socket.on('leave-room', ({ room } = {}) => {
    stopWaiting(socket)
    leaveRoom(socket, cleanCode(room) || socket.data.room)
  })

  socket.on('disconnect', () => {
    stopWaiting(socket)
    leaveRoom(socket, socket.data.room)
  })
})

// ERROR HANDLER
app.use((error, _req, res, _next) => {
  console.error('Server error:', error.message)

  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: error.message })
  }

  if (error.message?.startsWith('CORS blocked')) {
    return res.status(403).json({ error: 'Origin not allowed by CORS.' })
  }

  res.status(400).json({
    error: error.message || 'Request failed.'
  })
})

// START: connect to the database (Cloud SQL or JSON files), then listen.
try {
  store = await createStore()
} catch (error) {
  console.error('Could not connect to the database:', error.message)
  console.error('Check DB_HOST, DB_USER, DB_PASSWORD, DB_NAME and the Cloud SQL authorized networks.')
  process.exit(1)
}

// LISTEN ON ALL NETWORK INTERFACES
server.listen(PORT, '0.0.0.0', () => {
  console.log(`CloudMeet backend listening on port ${PORT}`)
  console.log('Allowed frontend origins:', configuredOrigins.join(', '))
  console.log(store.mode === 'mysql'
    ? `Database: Cloud SQL (MySQL) at ${process.env.DB_HOST}, database "${process.env.DB_NAME || 'cloudmeet'}"`
    : 'Database: JSON files in backend/data (set DB_HOST to use Cloud SQL)')
  console.log(cloudStorageEnabled
    ? `Recordings: Google Cloud Storage bucket "${cloudStorageBucket}"`
    : 'Recordings: local disk (set GCS_BUCKET to use Cloud Storage)')
  console.log(RETENTION_DAYS > 0
    ? `Recordings are deleted automatically after ${RETENTION_DAYS} days`
    : 'Recordings are kept forever (RECORDING_RETENTION_DAYS=0)')

  setTimeout(removeExpiredRecordings, 30 * 1000)
  setInterval(removeExpiredRecordings, 60 * 60 * 1000)
})
