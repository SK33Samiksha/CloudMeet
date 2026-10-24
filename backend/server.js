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

function authenticate(req, res, next) {
  const token = (req.headers.authorization || '')
    .replace(/^Bearer\s+/i, '')

  const [payload, signature] = token.split('.')

  if (!payload || !signature) {
    return res.status(401).json({ error: 'Please sign in.' })
  }

  const expected = createHmac('sha256', TOKEN_SECRET)
    .update(payload)
    .digest()

  const actual = Buffer.from(signature, 'base64url')

  if (
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    return res.status(401).json({
      error: 'Invalid session. Please sign in again.'
    })
  }

  try {
    const user = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    )

    if (!user.id || !user.exp || user.exp < Date.now()) {
      return res.status(401).json({
        error: 'Session expired. Please sign in again.'
      })
    }

    req.user = user
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid session.' })
  }
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

// LIST RECORDINGS
app.get('/api/recordings', authenticate, (_req, res) => {
  try {
    const recordings = readJson(RECORDINGS_FILE).map(toPublicRecording)

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
    recording: Boolean(meta.recording)
  }
}

io.on('connection', socket => {
  socket.on('join-room', payload => {
    const room = typeof payload?.room === 'string'
      ? payload.room.trim().toUpperCase().slice(0, 40)
      : ''

    const name = typeof payload?.name === 'string'
      ? payload.name.trim().slice(0, 32) || 'Guest'
      : 'Guest'

    if (!room) return

    if (socket.data.room) {
      leaveRoom(socket.data.room)
    }

    const users = roomUsers.get(room) || new Map()
    const meta = roomMeta.get(room) || { hostId: null, recording: false }

    // The person who created the meeting becomes the host. If the host
    // reconnects (new socket.id), they become host again.
    if (payload?.host === true && (!meta.hostId || !users.has(meta.hostId))) {
      meta.hostId = socket.id
    }
    roomMeta.set(room, meta)

    const existingUsers = [...users.entries()].map(
      ([id, user]) => publicUser(id, user)
    )

    socket.join(room)
    socket.data.room = room
    socket.data.name = name

    const user = {
      name,
      micOn: payload?.micOn !== false,
      cameraOn: payload?.cameraOn !== false,
      screenSharing: false,
      isHost: meta.hostId === socket.id
    }

    users.set(socket.id, user)
    roomUsers.set(room, users)

    socket.emit('room-state', { ...roomState(room), selfId: socket.id })
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
    const cleanRoom = typeof room === 'string'
      ? room.trim().toUpperCase()
      : ''

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

    io.to(cleanRoom).emit('chat-message', {
      id: `${Date.now()}-${socket.id}`,
      // Use the name the server already knows, so nobody can send a
      // message pretending to be someone else.
      senderId: socket.id,
      name: socket.data.name || 'Guest',
      message: cleanMessage,
      time: Date.now()
    })
  })

  function leaveRoom(room) {
    if (!room) return

    socket.leave(room)

    const users = roomUsers.get(room)

    if (users) {
      users.delete(socket.id)

      if (users.size === 0) {
        roomUsers.delete(room)
        roomMeta.delete(room)
      } else {
        roomUsers.set(room, users)
      }
    }

    // If the host leaves while recording, turn the indicator off.
    const meta = roomMeta.get(room)
    if (meta && meta.hostId === socket.id && meta.recording) {
      meta.recording = false
      socket.to(room).emit('room-state', roomState(room))
    }

    socket.to(room).emit('user-left', socket.id)

    if (socket.data.room === room) {
      socket.data.room = null
    }
  }

  socket.on('leave-room', ({ room } = {}) => {
    leaveRoom(room || socket.data.room)
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
