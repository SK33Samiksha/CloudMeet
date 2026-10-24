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

const app = express()
const server = http.createServer(app)
const PORT = Number(process.env.PORT || 5000)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, 'data')
const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings')
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const RECORDINGS_FILE = path.join(DATA_DIR, 'recordings.json')

mkdirSync(RECORDINGS_DIR, { recursive: true })

if (!existsSync(USERS_FILE)) writeFileSync(USERS_FILE, '[]')
if (!existsSync(RECORDINGS_FILE)) writeFileSync(RECORDINGS_FILE, '[]')

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

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    console.error(`Could not read ${file}:`, error.message)
    throw new Error('Data storage is unavailable.')
  }
}

function writeJson(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
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

// ---------------------------------------------------------------
// MEETING STORAGE (backend/data/meetings.json)
// One record per meeting code. The fields follow the Meetings,
// Participants and Messages tables in the project report, so this
// can later be moved to Cloud SQL (MySQL) table by table.
// ---------------------------------------------------------------
const MEETINGS_FILE = path.join(DATA_DIR, 'meetings.json')
if (!existsSync(MEETINGS_FILE)) writeFileSync(MEETINGS_FILE, '[]')

const MAX_SAVED_MESSAGES = 300

function loadMeetings() {
  return readJson(MEETINGS_FILE)
}

function saveMeetings(meetings) {
  writeJson(MEETINGS_FILE, meetings)
}

function findMeeting(code, meetings = loadMeetings()) {
  return meetings.find(meeting => meeting.id === code) || null
}

// Change one meeting record and save the file.
function updateMeeting(code, change) {
  const meetings = loadMeetings()
  const meeting = findMeeting(code, meetings)
  if (!meeting) return null
  change(meeting)
  saveMeetings(meetings)
  return meeting
}

function cleanCode(value) {
  return typeof value === 'string'
    ? value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)
    : ''
}

function newMeetingCode(meetings) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code
  do {
    code = Array.from(randomBytes(6), byte => letters[byte % letters.length]).join('')
  } while (findMeeting(code, meetings))
  return code
}

function attendedMeeting(meeting, userId) {
  return Boolean(meeting) && (
    meeting.host_user_id === userId ||
    meeting.participants.some(person => person.user_id === userId)
  )
}

// Who may watch a recording:
//  - the host who recorded it,
//  - anyone who attended that meeting,
//  - anyone who entered the meeting code on the Recordings page
//    (for example a student who missed the lecture) — saved in "viewers".
// Older recordings made before meetings were saved have no meeting
// record, so every signed-in user may see them.
function canViewRecording(recording, userId, meetings) {
  if (recording.host_id === userId) return true
  const meeting = findMeeting(recording.room, meetings)
  if (!meeting) return true
  return attendedMeeting(meeting, userId) ||
    (meeting.viewers || []).includes(userId)
}

// API health checks
app.get('/', (_req, res) => {
  res.json({ app: 'CloudMeet API', status: 'running' })
})

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

// SIGN UP
app.post('/api/auth/signup', (req, res) => {
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
    const users = readJson(USERS_FILE)

    if (users.some(user => user.email === email)) {
      return res.status(409).json({
        error: 'This account already exists. Please sign in.'
      })
    }

    const id = users.reduce(
      (max, user) => Math.max(max, Number(user.id) || 0),
      0
    ) + 1

    const newUser = {
      id,
      name,
      email,
      password_hash: hashPassword(password),
      created_at: new Date().toISOString()
    }

    users.push(newUser)
    writeJson(USERS_FILE, users)

    const user = { id, name, email }

    return res.status(201).json({
      user,
      token: createToken(user)
    })
  } catch (error) {
    console.error('Signup failed:', error)
    return res.status(500).json({
      error: 'Could not create the account.'
    })
  }
})

// SIGN IN
app.post('/api/auth/login', (req, res) => {
  const email = typeof req.body?.email === 'string'
    ? req.body.email.trim().toLowerCase()
    : ''

  const password = typeof req.body?.password === 'string'
    ? req.body.password
    : ''

  try {
    const users = readJson(USERS_FILE)
    const account = users.find(user => user.email === email)

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
app.get('/api/auth/me', authenticate, (req, res) => {
  try {
    const account = readJson(USERS_FILE)
      .find(user => user.id === req.user.id)

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
app.put('/api/auth/profile', authenticate, (req, res) => {
  const name = typeof req.body?.name === 'string'
    ? req.body.name.trim().slice(0, 80)
    : ''

  if (name.length < 2) {
    return res.status(400).json({ error: 'Name must have at least 2 characters.' })
  }

  try {
    const users = readJson(USERS_FILE)
    const account = users.find(user => user.id === req.user.id)

    if (!account) {
      return res.status(404).json({ error: 'Account not found.' })
    }

    account.name = name
    writeJson(USERS_FILE, users)

    const user = { id: account.id, name: account.name, email: account.email }
    // The token contains the name, so give the browser a fresh token.
    res.json({ user, token: createToken(user) })
  } catch (error) {
    console.error('Profile update failed:', error)
    res.status(500).json({ error: 'Could not update your profile.' })
  }
})

// CHANGE PASSWORD
app.put('/api/auth/password', authenticate, (req, res) => {
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
    const users = readJson(USERS_FILE)
    const account = users.find(user => user.id === req.user.id)

    if (!account) {
      return res.status(404).json({ error: 'Account not found.' })
    }

    if (!verifyPassword(currentPassword, account.password_hash)) {
      return res.status(400).json({ error: 'Current password is incorrect.' })
    }

    account.password_hash = hashPassword(newPassword)
    writeJson(USERS_FILE, users)
    res.json({ ok: true })
  } catch (error) {
    console.error('Password change failed:', error)
    res.status(500).json({ error: 'Could not change your password.' })
  }
})

// CREATE A MEETING — the server generates a unique code.
app.post('/api/meetings', authenticate, (req, res) => {
  const title = typeof req.body?.title === 'string' && req.body.title.trim()
    ? req.body.title.trim().slice(0, 80)
    : 'Team meeting'

  try {
    const meetings = loadMeetings()
    const meeting = {
      id: newMeetingCode(meetings),
      title,
      host_user_id: req.user.id,
      host_name: req.user.name,
      created_at: new Date().toISOString(),
      status: 'scheduled',
      participants: [],
      viewers: [],
      messages: []
    }
    meetings.push(meeting)
    saveMeetings(meetings)
    res.status(201).json({
      meeting: { id: meeting.id, title: meeting.title, hostName: meeting.host_name }
    })
  } catch (error) {
    console.error('Meeting create failed:', error)
    res.status(500).json({ error: 'Could not create the meeting.' })
  }
})

// CHECK A MEETING CODE (used by the join form and invite links)
app.get('/api/meetings/:code', authenticate, (req, res) => {
  try {
    const meeting = findMeeting(cleanCode(req.params.code))

    if (!meeting) {
      return res.status(404).json({
        error: 'No meeting found with this code. Check the code and try again.'
      })
    }

    res.json({
      meeting: {
        id: meeting.id,
        title: meeting.title,
        hostName: meeting.host_name,
        status: meeting.status,
        createdAt: new Date(meeting.created_at).getTime()
      }
    })
  } catch {
    res.status(500).json({ error: 'Could not check the meeting code.' })
  }
})

// MY ATTENDANCE — every time this user joined a meeting (any device).
app.get('/api/attendance', authenticate, (req, res) => {
  try {
    const records = []

    for (const meeting of loadMeetings()) {
      for (const person of meeting.participants) {
        if (person.user_id !== req.user.id) continue
        const joinedAt = new Date(person.joined_at).getTime()
        const leftAt = person.left_at ? new Date(person.left_at).getTime() : null
        records.push({
          id: person.id,
          room: meeting.id,
          title: meeting.title,
          name: person.name,
          role: meeting.host_user_id === req.user.id ? 'Host' : 'Participant',
          joinedAt,
          leftAt,
          durationMinutes: leftAt
            ? Math.max(1, Math.round((leftAt - joinedAt) / 60000))
            : null,
          participantCount: new Set(meeting.participants.map(p => p.user_id)).size
        })
      }
    }

    records.sort((a, b) => b.joinedAt - a.joinedAt)
    res.json({ attendance: records })
  } catch {
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
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: 'Select a video file to upload.'
      })
    }

    const title = String(req.body?.title || 'Recorded class')
      .trim()
      .slice(0, 120)

    const room = String(req.body?.room || '')
      .trim()
      .slice(0, 40)

    const durationSeconds = Math.max(
      0,
      Math.min(24 * 60 * 60, Math.round(Number(req.body?.durationSeconds) || 0))
    )

    // Only the meeting's host may upload its recording.
    const meeting = findMeeting(cleanCode(room))
    if (meeting && meeting.host_user_id !== req.user.id) {
      try { unlinkSync(req.file.path) } catch {}
      return res.status(403).json({
        error: 'Only the host of this meeting can save its recording.'
      })
    }

    try {
      const recordings = readJson(RECORDINGS_FILE)

      const recording = {
        id: randomBytes(12).toString('hex'),
        title,
        room,
        filename: req.file.filename,
        size: req.file.size,
        duration_seconds: durationSeconds,
        created_at: new Date().toISOString(),
        host_id: req.user.id,
        host_name: req.user.name
      }

      recordings.unshift(recording)
      writeJson(RECORDINGS_FILE, recordings)

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
    url: `/api/recordings/${recording.id}/video`
  }
}

// UNLOCK A MEETING'S RECORDINGS WITH ITS CODE
// A student who missed the meeting enters the code the host shared.
// From then on, all recordings of that meeting appear in their library.
app.post('/api/recordings/access', authenticate, (req, res) => {
  const code = cleanCode(req.body?.code)

  if (!code) {
    return res.status(400).json({ error: 'Enter the meeting code.' })
  }

  try {
    const meeting = updateMeeting(code, record => {
      record.viewers = record.viewers || []
      if (
        !attendedMeeting(record, req.user.id) &&
        !record.viewers.includes(req.user.id)
      ) {
        record.viewers.push(req.user.id)
      }
    })

    if (!meeting) {
      return res.status(404).json({
        error: 'No meeting found with this code. Check the code and try again.'
      })
    }

    const count = readJson(RECORDINGS_FILE)
      .filter(recording => recording.room === code).length

    res.json({
      meeting: { id: meeting.id, title: meeting.title, hostName: meeting.host_name },
      recordingCount: count
    })
  } catch (error) {
    console.error('Recording access failed:', error)
    res.status(500).json({ error: 'Could not check the meeting code.' })
  }
})

// LIST RECORDINGS
app.get('/api/recordings', authenticate, (req, res) => {
  try {
    const meetings = loadMeetings()
    const recordings = readJson(RECORDINGS_FILE)
      .filter(recording => canViewRecording(recording, req.user.id, meetings))
      .map(recording => ({
        ...toPublicRecording(recording),
        // Only the host is told how many people watched.
        viewCount: recording.host_id === req.user.id
          ? (recording.views || []).length
          : undefined
      }))

    res.json({ recordings })
  } catch {
    res.status(500).json({
      error: 'Could not load recordings.'
    })
  }
})

// STREAM A RECORDING
app.get('/api/recordings/:id/video', authenticateWithQueryToken, (req, res) => {
  try {
    const recording = readJson(RECORDINGS_FILE)
      .find(item => item.id === req.params.id)

    if (!recording) {
      return res.status(404).json({ error: 'Recording not found.' })
    }

    if (!canViewRecording(recording, req.user.id, loadMeetings())) {
      return res.status(403).json({
        error: 'Only people who attended this meeting can watch the recording.'
      })
    }

    const filePath = path.join(RECORDINGS_DIR, recording.filename)

    if (!existsSync(filePath)) {
      return res.status(404).json({ error: 'Video file is missing.' })
    }

    res.sendFile(filePath)
  } catch {
    res.status(500).json({
      error: 'Could not play recording.'
    })
  }
})

// SOMEONE PRESSED PLAY — remember their name and the date.
// One entry per person; watching again updates the date.
app.post('/api/recordings/:id/view', authenticate, (req, res) => {
  try {
    const recordings = readJson(RECORDINGS_FILE)
    const recording = recordings.find(item => item.id === req.params.id)

    if (!recording) {
      return res.status(404).json({ error: 'Recording not found.' })
    }

    if (!canViewRecording(recording, req.user.id, loadMeetings())) {
      return res.status(403).json({ error: 'You cannot watch this recording.' })
    }

    // The host watching their own recording is not counted.
    if (recording.host_id !== req.user.id) {
      const account = readJson(USERS_FILE).find(user => user.id === req.user.id)
      recording.views = (recording.views || []).filter(view => view.user_id !== req.user.id)
      recording.views.push({
        user_id: req.user.id,
        name: account?.name || req.user.name,
        watched_at: new Date().toISOString()
      })
      writeJson(RECORDINGS_FILE, recordings)
    }

    res.json({ ok: true })
  } catch (error) {
    console.error('Saving view failed:', error)
    res.status(500).json({ error: 'Could not save the view.' })
  }
})

// WHO WATCHED A RECORDING (only the host who recorded it)
app.get('/api/recordings/:id/viewers', authenticate, (req, res) => {
  try {
    const recording = readJson(RECORDINGS_FILE)
      .find(item => item.id === req.params.id)

    if (!recording) {
      return res.status(404).json({ error: 'Recording not found.' })
    }

    if (recording.host_id !== req.user.id) {
      return res.status(403).json({
        error: 'Only the host who recorded this meeting can see who watched it.'
      })
    }

    const viewers = (recording.views || [])
      .map(view => ({ name: view.name, watchedAt: new Date(view.watched_at).getTime() }))
      .sort((a, b) => b.watchedAt - a.watchedAt)

    res.json({ viewers })
  } catch {
    res.status(500).json({ error: 'Could not load viewers.' })
  }
})

// DELETE A RECORDING (only the host who uploaded it)
app.delete('/api/recordings/:id', authenticate, (req, res) => {
  try {
    const recordings = readJson(RECORDINGS_FILE)
    const recording = recordings.find(item => item.id === req.params.id)

    if (!recording) {
      return res.status(404).json({ error: 'Recording not found.' })
    }

    if (recording.host_id !== req.user.id) {
      return res.status(403).json({
        error: 'Only the host who recorded this meeting can delete it.'
      })
    }

    const filePath = path.join(RECORDINGS_DIR, recording.filename)
    if (existsSync(filePath)) unlinkSync(filePath)

    writeJson(
      RECORDINGS_FILE,
      recordings.filter(item => item.id !== recording.id)
    )

    res.json({ ok: true })
  } catch (error) {
    console.error('Recording delete failed:', error)
    res.status(500).json({ error: 'Could not delete recording.' })
  }
})

// SOCKET.IO: MEETING CHAT AND WEBRTC SIGNALING
// roomUsers: room code -> Map(socket.id -> participant details)
// roomMeta:  room code -> { hostId, recording }
// The socket.id is the participant ID everywhere: in Socket.IO events,
// in the browser's peer-connection list, and as the React key of each tile.
// The signed-in account (user ID) is used for attendance and permissions.
const roomUsers = new Map()
const roomMeta = new Map()

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
    title: meta.title || 'Team meeting'
  }
}

io.on('connection', socket => {
  socket.on('join-room', payload => {
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
      meeting = findMeeting(room)
    } catch {
      return socket.emit('join-error', { error: 'Meeting data is unavailable. Check the backend.' })
    }

    if (!meeting) {
      return socket.emit('join-error', {
        error: `No meeting found with code ${room}. Check the code and try again.`
      })
    }

    if (socket.data.room) {
      leaveRoom(socket.data.room)
    }

    const users = roomUsers.get(room) || new Map()
    const meta = roomMeta.get(room) || { hostId: null, recording: false }
    meta.title = meeting.title

    // The account that created the meeting is the host. If the host
    // reconnects (new socket.id), they become host again.
    const isHostAccount = meeting.host_user_id === account.id
    if (isHostAccount) meta.hostId = socket.id
    roomMeta.set(room, meta)

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

    // Save attendance: one entry per join, closed when they leave.
    const attendanceId = randomBytes(8).toString('hex')
    socket.data.attendanceId = attendanceId
    let history = []
    try {
      const saved = updateMeeting(room, record => {
        record.status = 'live'
        record.participants.push({
          id: attendanceId,
          user_id: account.id,
          name,
          joined_at: new Date().toISOString(),
          left_at: null
        })
      })
      history = (saved?.messages || []).slice(-100).map(message => ({
        id: message.id,
        senderId: null,
        name: message.name,
        message: message.message_text,
        time: new Date(message.sent_at).getTime()
      }))
    } catch (saveError) {
      console.error('Could not save attendance:', saveError.message)
    }

    socket.emit('room-state', { ...roomState(room), selfId: socket.id })
    socket.emit('chat-history', history)
    socket.emit('room-users', existingUsers)
    socket.to(room).emit('user-joined', publicUser(socket.id, user))
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

  socket.on('signal', ({ to, data } = {}) => {
    if (typeof to === 'string' && data) {
      io.to(to).emit('signal', {
        from: socket.id,
        data
      })
    }
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

    // Keep the chat with the meeting (like the Messages table).
    try {
      updateMeeting(cleanRoom, record => {
        record.messages.push({
          id: chat.id,
          sender_user_id: socket.data.userId,
          name: chat.name,
          message_text: chat.message,
          sent_at: new Date(chat.time).toISOString()
        })
        if (record.messages.length > MAX_SAVED_MESSAGES) {
          record.messages = record.messages.slice(-MAX_SAVED_MESSAGES)
        }
      })
    } catch (saveError) {
      console.error('Could not save chat message:', saveError.message)
    }
  })

  function leaveRoom(room) {
    if (!room) return

    socket.leave(room)

    const users = roomUsers.get(room)
    let roomIsEmpty = false

    if (users) {
      users.delete(socket.id)

      if (users.size === 0) {
        roomUsers.delete(room)
        roomMeta.delete(room)
        roomIsEmpty = true
      } else {
        roomUsers.set(room, users)
      }
    }

    // Close this person's attendance entry.
    const attendanceId = socket.data.attendanceId
    socket.data.attendanceId = null
    try {
      updateMeeting(room, record => {
        const entry = record.participants.find(item => item.id === attendanceId)
        if (entry && !entry.left_at) entry.left_at = new Date().toISOString()
        if (roomIsEmpty) record.status = 'ended'
      })
    } catch (saveError) {
      console.error('Could not save leave time:', saveError.message)
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

  socket.on('leave-room', ({ room } = {}) => {
    leaveRoom(cleanCode(room) || socket.data.room)
  })

  socket.on('disconnect', () => {
    leaveRoom(socket.data.room)
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

// LISTEN ON ALL NETWORK INTERFACES
server.listen(PORT, '0.0.0.0', () => {
  console.log(`CloudMeet backend listening on port ${PORT}`)
  console.log('Allowed frontend origins:', configuredOrigins.join(', '))
})
