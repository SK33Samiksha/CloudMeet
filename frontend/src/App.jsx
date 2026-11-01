import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { Room, RoomEvent, Track } from 'livekit-client'
import {
  Video, VideoOff, Mic, MicOff, MonitorUp, MessageCircle, Users,
  Copy, Plus, ArrowRight, PhoneOff, ShieldCheck, Cloud, X, Send,
  Link2, Check, Sparkles, CalendarCheck, History, Clock, BarChart3, Circle, Square, Film, Play, Download, Trash2, UserRound, KeyRound,
  Maximize2, Minimize2, UserX, Lock, ZoomIn, ZoomOut
} from 'lucide-react'

// When these are empty, the browser uses the same address it opened
// (for example https://192.168.1.5:5173) and Vite forwards /api and
// /socket.io to the backend. See vite.config.js.
// An https page may not call an http:// backend (the browser blocks it as
// "mixed content"), so an old http:// value in .env is ignored on https.
function backendUrl(value) {
  if (!value) return ''
  if (window.location.protocol === 'https:' && value.startsWith('http:')) return ''
  return value.replace(/\/$/, '')
}
const SIGNALING_URL = backendUrl(import.meta.env.VITE_SIGNALING_URL) || undefined
const API_URL = backendUrl(import.meta.env.VITE_API_URL || import.meta.env.VITE_SIGNALING_URL)

// STUN helps each laptop discover its public address. A TURN relay is only
// needed on strict networks; it is read from .env so no secret is hard-coded.
const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]
if (import.meta.env.VITE_TURN_URL) {
  iceServers.push({
    urls: import.meta.env.VITE_TURN_URL,
    username: import.meta.env.VITE_TURN_USERNAME || undefined,
    credential: import.meta.env.VITE_TURN_CREDENTIAL || undefined
  })
}
const iceConfig = { iceServers }

function cleanMeetingCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)
}

// Invite links look like https://HOST:5173/?room=AB12CD
function inviteCodeFromUrl() {
  try { return cleanMeetingCode(new URLSearchParams(window.location.search).get('room')) } catch { return '' }
}

function clearInviteFromUrl() {
  try {
    const url = new URL(window.location.href)
    if (url.searchParams.has('room')) { url.searchParams.delete('room'); window.history.replaceState(null, '', url.pathname + url.search + url.hash) }
  } catch {}
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

const MAX_ZOOM = 8
const DOUBLE_TAP_ZOOM = 3

// Make a shared screen as sharp as possible. Zooming only enlarges the picture
// that was received, so the sender must send a picture with enough detail.
async function tuneVideoSender(sender, sharp) {
  try {
    const params = sender.getParameters()
    if (!params.encodings || !params.encodings.length) params.encodings = [{}]
    if (sharp) {
      params.encodings[0].maxBitrate = 4000000
      params.degradationPreference = 'maintain-resolution'
    } else {
      delete params.encodings[0].maxBitrate
      params.degradationPreference = 'balanced'
    }
    await sender.setParameters(params)
  } catch (error) {
    console.warn('Could not tune the video sender:', error?.message)
  }
}

// One tile per participant. The tile is shown even before the video arrives.
// The <video> element stays mounted while a stream exists (only hidden when the
// camera is off) so that the participant's AUDIO keeps playing.
//
// ZOOM works like the photo gallery on a phone:
//  - mouse wheel / trackpad: zoom into the point under the cursor
//  - double-click or double-tap: zoom in there (again: back to normal)
//  - pinch with two fingers (shared screens)
//  - drag to move around the zoomed picture
//  - the + / - buttons zoom around the centre
// Click a shared screen once (or use the expand button) for full screen.
function VideoTile({ stream, name, muted = false, isLocal = false, showVideo = false, micOn = true, status = '', isHost = false, presenting = false, mirror = false }) {
  const ref = useRef(null)
  const tileRef = useRef(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [smooth, setSmooth] = useState(false)
  // The refs hold the latest values for the event handlers below.
  const zoomRef = useRef(1)
  const panRef = useRef({ x: 0, y: 0 })
  const pointersRef = useRef(new Map())
  const pinchRef = useRef(null)
  const gestureRef = useRef(null)
  const lastTapRef = useRef(null)
  const suppressClickRef = useRef(false)
  const clickTimerRef = useRef(null)
  const fullscreenRef = useRef(false)
  const showVideoRef = useRef(false)
  useEffect(() => { fullscreenRef.current = fullscreen }, [fullscreen])
  useEffect(() => { showVideoRef.current = showVideo }, [showVideo])
  useEffect(() => () => clearTimeout(clickTimerRef.current), [])
  useEffect(() => {
    const video = ref.current
    if (!video) return
    if (video.srcObject !== stream) video.srcObject = stream || null
    if (stream) video.play?.().catch(() => {})
  }, [stream])
  // Keep the button icon in step with the browser (Esc also leaves full screen).
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === tileRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  function toggleFullscreen(event) {
    event?.stopPropagation()
    const tile = tileRef.current
    if (!tile) return
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
    else tile.requestFullscreen?.().catch(() => {})
  }

  // Keep the picture inside the tile while zoomed.
  function clampPan(next, level) {
    const rect = tileRef.current?.getBoundingClientRect()
    if (!rect || level <= 1) return { x: 0, y: 0 }
    const maxX = (rect.width * (level - 1)) / 2
    const maxY = (rect.height * (level - 1)) / 2
    return { x: Math.max(-maxX, Math.min(maxX, next.x)), y: Math.max(-maxY, Math.min(maxY, next.y)) }
  }
  function setView(level, nextPan, animate = false) {
    const z = Math.max(1, Math.min(MAX_ZOOM, level))
    const p = clampPan(nextPan, z)
    zoomRef.current = z
    panRef.current = p
    setSmooth(animate)
    setZoom(z)
    setPan(p)
  }
  // Zoom by "factor" while the point under the cursor / fingers stays where it is.
  function zoomAt(clientX, clientY, factor, animate = false) {
    const rect = tileRef.current?.getBoundingClientRect()
    if (!rect) return
    const px = (clientX ?? rect.left + rect.width / 2) - (rect.left + rect.width / 2)
    const py = (clientY ?? rect.top + rect.height / 2) - (rect.top + rect.height / 2)
    const oldZoom = zoomRef.current
    const newZoom = Math.max(1, Math.min(MAX_ZOOM, oldZoom * factor))
    const ratio = newZoom / oldZoom
    const old = panRef.current
    setView(newZoom, { x: px - ratio * (px - old.x), y: py - ratio * (py - old.y) }, animate)
  }
  function zoomButton(event, factor) {
    event.stopPropagation()
    zoomAt(null, null, factor, true)
  }
  function resetZoom() { setView(1, { x: 0, y: 0 }, true) }
  function doubleTap(x, y) {
    clearTimeout(clickTimerRef.current)
    if (zoomRef.current > 1.05) resetZoom()
    else zoomAt(x, y, DOUBLE_TAP_ZOOM, true)
  }

  // Mouse wheel / trackpad zoom (needs a non-passive listener to stop the page scrolling).
  useEffect(() => {
    const tile = tileRef.current
    if (!tile) return
    const onWheel = event => {
      if (!showVideoRef.current) return
      event.preventDefault()
      const step = Math.max(-100, Math.min(100, event.deltaY))
      zoomAt(event.clientX, event.clientY, Math.exp(-step * 0.002), true)
    }
    tile.addEventListener('wheel', onWheel, { passive: false })
    return () => tile.removeEventListener('wheel', onWheel)
  }, [])

  function pointerDown(event) {
    if (!showVideoRef.current || event.button !== 0 || event.target.closest('button')) return
    const pointers = pointersRef.current
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.size === 1) gestureRef.current = { total: 0, multi: false }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      pinchRef.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      if (gestureRef.current) gestureRef.current.multi = true
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  function pointerMove(event) {
    const pointers = pointersRef.current
    const before = pointers.get(event.pointerId)
    if (!before) return
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.size === 2) {
      // Pinch: zoom around the middle between the two fingers, and follow them.
      const [a, b] = [...pointers.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const last = pinchRef.current
      if (last && last.dist > 0) {
        panRef.current = { x: panRef.current.x + mid.x - last.x, y: panRef.current.y + mid.y - last.y }
        zoomAt(mid.x, mid.y, dist / last.dist, false)
      }
      pinchRef.current = { dist, x: mid.x, y: mid.y }
      return
    }
    if (pointers.size === 1) {
      const dx = event.clientX - before.x
      const dy = event.clientY - before.y
      const gesture = gestureRef.current
      if (gesture) gesture.total += Math.abs(dx) + Math.abs(dy)
      // Drag to move around a zoomed picture.
      if (zoomRef.current > 1 && gesture && gesture.total > 3) {
        setView(zoomRef.current, { x: panRef.current.x + dx, y: panRef.current.y + dy }, false)
      }
    }
  }
  function pointerUp(event) {
    const pointers = pointersRef.current
    if (!pointers.has(event.pointerId)) return
    pointers.delete(event.pointerId)
    if (pointers.size < 2) pinchRef.current = null
    if (pointers.size > 0) return
    const gesture = gestureRef.current
    const isTap = event.type === 'pointerup' && gesture && !gesture.multi && gesture.total <= 6
    if (isTap) {
      // Two quick taps in the same place = double tap = zoom.
      const now = Date.now()
      const last = lastTapRef.current
      if (last && now - last.time < 300 && Math.hypot(event.clientX - last.x, event.clientY - last.y) < 30) {
        lastTapRef.current = null
        suppressClickRef.current = true
        doubleTap(event.clientX, event.clientY)
      } else {
        lastTapRef.current = { time: now, x: event.clientX, y: event.clientY }
      }
    }
    // The click event comes right after this; keep the gesture until then.
    setTimeout(() => { gestureRef.current = null }, 0)
  }
  function tileClick() {
    if (suppressClickRef.current) { suppressClickRef.current = false; return }
    const gesture = gestureRef.current
    if (gesture && (gesture.multi || gesture.total > 6)) return
    if (!presenting || fullscreenRef.current || zoomRef.current > 1.05) return
    // Wait a moment: a second tap means "zoom", not "full screen".
    clearTimeout(clickTimerRef.current)
    clickTimerRef.current = setTimeout(() => toggleFullscreen(), 320)
  }

  return <div ref={tileRef} className={`video-tile ${isLocal ? 'local-tile' : ''} ${presenting ? 'presenting-tile' : ''} ${fullscreen ? 'is-fullscreen' : ''}`} onClick={tileClick} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} style={zoom > 1 || presenting ? { touchAction: 'none', ...(zoom > 1 ? { cursor: 'grab' } : {}) } : undefined}>
    {stream && <video ref={ref} autoPlay playsInline muted={muted} className={`${showVideo ? '' : 'video-hidden'} ${mirror ? 'mirrored' : ''}`} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${mirror ? -zoom : zoom}, ${zoom})`, transition: smooth ? 'transform .18s ease-out' : 'none' }} />}
    {!showVideo && <div className="avatar">{initials(name)}</div>}
    {status && <span className="tile-status">{status}</span>}
    {showVideo && <div className="tile-tools">
      <button type="button" onClick={event => zoomButton(event, 1 / 1.5)} disabled={zoom <= 1} title="Zoom out" aria-label="Zoom out"><ZoomOut size={15}/></button>
      <button type="button" className="zoom-level" onClick={event => { event.stopPropagation(); resetZoom() }} title="Reset zoom" aria-label="Reset zoom">{Math.round(zoom * 100)}%</button>
      <button type="button" onClick={event => zoomButton(event, 1.5)} disabled={zoom >= MAX_ZOOM} title="Zoom in" aria-label="Zoom in"><ZoomIn size={15}/></button>
      <button type="button" onClick={toggleFullscreen} title={fullscreen ? 'Exit full screen' : 'Full screen'} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}>{fullscreen ? <Minimize2 size={15}/> : <Maximize2 size={15}/>}</button>
    </div>}
    {showVideo && zoom === 1 && <span className="tile-hint">Scroll or double-click to zoom{presenting ? ' · click for full screen' : ''}</span>}
    <div className="tile-label"><span className="live-dot" />{name}{isLocal ? ' (You)' : ''}{isHost && <span className="host-chip">Host</span>}{presenting && <span className="host-chip">Presenting</span>}</div>
    {!micOn && <span className="muted-indicator" title="Microphone muted"><MicOff size={14}/></span>}
  </div>
}

const RECORDING_DB = 'cloudmeet-recordings-v1'
const RECORDING_STORE = 'videos'

function openRecordingDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RECORDING_DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(RECORDING_STORE, { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function saveRecording(record) {
  const db = await openRecordingDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECORDING_STORE, 'readwrite')
    tx.objectStore(RECORDING_STORE).put(record)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}
async function getRecordings() {
  const db = await openRecordingDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECORDING_STORE, 'readonly')
    const req = tx.objectStore(RECORDING_STORE).getAll()
    req.onsuccess = () => { db.close(); resolve((req.result || []).sort((a, b) => b.createdAt - a.createdAt)) }
    req.onerror = () => { db.close(); reject(req.error) }
  })
}
async function deleteRecording(id) {
  const db = await openRecordingDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECORDING_STORE, 'readwrite')
    tx.objectStore(RECORDING_STORE).delete(id)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

export default function App() {
  const [screen, setScreen] = useState(() => localStorage.getItem('cloudmeet-token') ? 'home' : 'auth')
  const [authMode, setAuthMode] = useState('login')
  const [authName, setAuthName] = useState('')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState('')
  const [currentUser, setCurrentUser] = useState(() => { try { return JSON.parse(localStorage.getItem('cloudmeet-user') || 'null') } catch { return null } })
  const [recordings, setRecordings] = useState([])
  const [recordingActive, setRecordingActive] = useState(false)
  const [recordingBusy, setRecordingBusy] = useState(false)
  const [recordingUrl, setRecordingUrl] = useState('')
  const recorderRef = useRef(null)
  const recordingChunksRef = useRef([])
  const recordingCanvasRef = useRef(null)
  const recordingAnimationRef = useRef(null)
  const recordingAudioContextRef = useRef(null)
  const recordingStopDrawingRef = useRef(null)
  const [recordingStatus, setRecordingStatus] = useState('')
  const [attendance, setAttendance] = useState([])
  const [attendanceError, setAttendanceError] = useState('')
  const [recordingsError, setRecordingsError] = useState('')
  const [recordingCode, setRecordingCode] = useState(inviteCodeFromUrl)
  const [recordingCodeMessage, setRecordingCodeMessage] = useState('')
  const [recordingCodeBusy, setRecordingCodeBusy] = useState(false)
  const [viewersFor, setViewersFor] = useState(null)
  const [viewersList, setViewersList] = useState(null)
  const [viewersError, setViewersError] = useState('')
  const [inviteRoom, setInviteRoom] = useState(inviteCodeFromUrl)
  const [meetingTitle, setMeetingTitle] = useState('Team meeting')
  const [newMeetingTitle, setNewMeetingTitle] = useState('')
  const [meetingBusy, setMeetingBusy] = useState(false)
  const [profileName, setProfileName] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [profileMessage, setProfileMessage] = useState('')
  const [profileError, setProfileError] = useState('')
  const [profileBusy, setProfileBusy] = useState(false)
  const meetingStartedAtRef = useRef(null)
  const [meetingCode, setMeetingCode] = useState(inviteCodeFromUrl)
  const [name, setName] = useState(() => localStorage.getItem('cloudmeet-name') || '')
  const [room, setRoom] = useState('')
  const [joined, setJoined] = useState(false)
  const [isHost, setIsHost] = useState(false)
  const [micOn, setMicOn] = useState(true)
  const [cameraOn, setCameraOn] = useState(true)
  const [chatOpen, setChatOpen] = useState(false)
  const [peopleOpen, setPeopleOpen] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [messages, setMessages] = useState([])
  const [participants, setParticipants] = useState([])
  const [status, setStatus] = useState('Connecting to meeting server…')
  const [copied, setCopied] = useState(false)
  const [notice, setNotice] = useState('')
  // Waiting room: guest side (waitingForHost) and host side (joinRequests).
  const [waitingForHost, setWaitingForHost] = useState(false)
  const [joinRequests, setJoinRequests] = useState([])
  const joinRequestIdsRef = useRef(new Set())
  const [meetingAccess, setMeetingAccess] = useState('ask')
  const [newAccessType, setNewAccessType] = useState('ask')
  const [newInvitedEmails, setNewInvitedEmails] = useState('')
  // People who asked the host for access to recordings.
  const [recordingRequests, setRecordingRequests] = useState([])
  const socketRef = useRef(null)
  const streamRef = useRef(null)
  const peersRef = useRef({})
  const pendingCandidatesRef = useRef({})
  const remoteStreamsRef = useRef({})
  const [remoteStreams, setRemoteStreams] = useState({})
  const [peerStates, setPeerStates] = useState({})
  const [localStream, setLocalStream] = useState(null)
  const [screenStream, setScreenStream] = useState(null)
  const screenStreamRef = useRef(null)
  const [roomRecording, setRoomRecording] = useState(false)
  // Saved when we join, so we can join again automatically after a reconnect.
  const joinInfoRef = useRef(null)
  const selfIdRef = useRef(null)
  const participantsRef = useRef([])
  // Media server (LiveKit). 'p2p' = direct connections between browsers, 'livekit' = media server.
  // The backend decides, and tells us in the 'room-state' message.
  const mediaModeRef = useRef('p2p')
  const lkRoomRef = useRef(null)
  const lkTracksRef = useRef({})
  const screenPubRef = useRef(null)
  const [lkState, setLkState] = useState('off')
  useEffect(() => { participantsRef.current = participants }, [participants])

  // Opened an invite link? Scroll to the join card on the home screen.
  useEffect(() => {
    if (screen === 'home' && inviteRoom) setTimeout(() => document.getElementById('join-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 150)
  }, [screen, inviteRoom])

  function flash(message, ms = 4000) {
    setNotice(message)
    setTimeout(() => setNotice(current => current === message ? '' : current), ms)
  }

  function currentMediaState() {
    const stream = streamRef.current
    return {
      micOn: Boolean(stream?.getAudioTracks().some(track => track.enabled)),
      cameraOn: Boolean(stream?.getVideoTracks().some(track => track.enabled)),
      screenSharing: Boolean(screenStreamRef.current)
    }
  }

  // Close and forget one peer connection. Used on leave, failure and reconnect.
  function removePeer(id) {
    peersRef.current[id]?.close()
    delete peersRef.current[id]
    delete pendingCandidatesRef.current[id]
    delete remoteStreamsRef.current[id]
    delete lkTracksRef.current[id]
    setRemoteStreams({ ...remoteStreamsRef.current })
    setPeerStates(prev => { const next = { ...prev }; delete next[id]; return next })
  }

  function removeAllPeers() {
    disconnectLivekit()
    Object.keys(peersRef.current).forEach(removePeer)
    peersRef.current = {}; pendingCandidatesRef.current = {}; remoteStreamsRef.current = {}
    setRemoteStreams({}); setPeerStates({})
  }

  function emitJoin() {
    const info = joinInfoRef.current
    if (!info || !socketRef.current?.connected) return
    // The token tells the server which account joined (for attendance and host rights).
    socketRef.current.emit('join-room', { ...info, ...currentMediaState(), token: localStorage.getItem('cloudmeet-token') })
  }

  // Calls the backend with the sign-in token. Throws an Error with a
  // readable message, and signs out automatically if the session expired.
  async function apiFetch(path, { json, ...options } = {}) {
    const token = localStorage.getItem('cloudmeet-token')
    const headers = { ...(options.headers || {}) }
    if (token) headers.Authorization = `Bearer ${token}`
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(json) }
    let response
    try { response = await fetch(`${API_URL}${path}`, { ...options, headers }) }
    catch { throw new Error('Cannot reach the CloudMeet server. Check that the backend is running.') }
    const data = await response.json().catch(() => ({}))
    if (response.status === 401 && token) {
      signOut(data.error || 'Your session has expired. Please sign in again.')
      throw new Error(data.error || 'Please sign in again.')
    }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`)
    return data
  }

  // Leave the meeting screen without saving anything (used when joining fails).
  function abortMeeting(message, mustSignOut = false) {
    joinInfoRef.current = null
    removeAllPeers()
    streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null; setLocalStream(null)
    screenStreamRef.current?.getTracks().forEach(t => t.stop()); screenStreamRef.current = null; setScreenStream(null)
    setParticipants([]); setJoined(false); setIsHost(false); setRoomRecording(false)
    setWaitingForHost(false); setJoinRequests([]); joinRequestIdsRef.current = new Set()
    if (mustSignOut) { signOut(message); return }
    setScreen('home')
    flash(message, 7000)
  }

  useEffect(() => {
    refreshRecordings()
    const socket = io(SIGNALING_URL, { autoConnect: true, reconnection: true })
    socketRef.current = socket
    socket.on('connect', () => {
      setStatus('Connected to meeting server')
      // After a reconnect the server gives us a new ID, so rebuild the call.
      if (joinInfoRef.current) {
        removeAllPeers()
        setParticipants([])
        emitJoin()
      }
    })
    socket.on('connect_error', err => setStatus(`Cannot reach meeting server (${err.message})`))
    socket.on('disconnect', () => setStatus('Disconnected — reconnecting…'))
    socket.on('chat-message', msg => setMessages(prev => [...prev, msg]))
    // Earlier messages of this meeting, so late joiners can read them.
    socket.on('chat-history', history => setMessages(Array.isArray(history) ? history : []))
    socket.on('join-error', ({ error, signOut: mustSignOut } = {}) => abortMeeting(error || 'Could not join the meeting.', mustSignOut))
    // Waiting room events
    socket.on('waiting-for-host', () => setWaitingForHost(true))
    socket.on('join-denied', () => abortMeeting('The host did not let you into the meeting.'))
    socket.on('removed-from-meeting', () => abortMeeting('The host removed you from the meeting.'))
    // Ticket for the media server. The backend sends it only after the host has let us in.
    socket.on('livekit-token', payload => connectLivekit(payload))
    socket.on('join-requests', list => {
      const next = Array.isArray(list) ? list : []
      const known = joinRequestIdsRef.current
      const added = next.filter(person => !known.has(person.id))
      joinRequestIdsRef.current = new Set(next.map(person => person.id))
      if (added.length) flash(`${added[0].name || 'Someone'} is asking to join`, 4000)
      setJoinRequests(next)
    })
    socket.on('room-state', state => {
      setWaitingForHost(false)
      if (state.media) mediaModeRef.current = state.media
      if (state.accessType) setMeetingAccess(state.accessType)
      if (state.selfId) selfIdRef.current = state.selfId
      if (state.title) setMeetingTitle(state.title)
      setIsHost(Boolean(state.hostId) && state.hostId === selfIdRef.current)
      setRoomRecording(Boolean(state.recording))
    })
    socket.on('room-users', async users => {
      // The server sends everyone already in this room to the newly joined user.
      // The new user starts (offers) a WebRTC connection to each of them.
      setParticipants(users)
      // With the media server there are no direct connections to build.
      if (mediaModeRef.current !== 'livekit') for (const user of users) await createPeer(user.id, true)
    })
    socket.on('user-joined', async user => {
      setParticipants(prev => prev.some(p => p.id === user.id)
        ? prev.map(p => p.id === user.id ? { ...p, ...user } : p)
        : [...prev, user])
      flash(`${user.name} joined the meeting`, 3000)
      // Wait for their offer; create the connection now so tracks are ready.
      if (mediaModeRef.current !== 'livekit') await createPeer(user.id, false)
    })
    socket.on('media-state', user => {
      setParticipants(prev => prev.map(p => p.id === user.id ? { ...p, ...user } : p))
    })
    socket.on('user-left', id => {
      const person = participantsRef.current.find(p => p.id === id)
      if (person) flash(`${person.name} left the meeting`, 3000)
      removePeer(id)
      setParticipants(prev => prev.filter(p => p.id !== id))
    })
    socket.on('signal', async ({ from, data }) => {
      if (mediaModeRef.current === 'livekit') return
      let pc = peersRef.current[from]
      if (!pc) pc = await createPeer(from, false)
      try {
        if (data?.description) {
          await pc.setRemoteDescription(data.description)
          const queued = pendingCandidatesRef.current[from] || []
          delete pendingCandidatesRef.current[from]
          for (const candidate of queued) {
            try { await pc.addIceCandidate(candidate) } catch (err) { console.warn('Queued ICE candidate could not be added:', err) }
          }
          if (data.description.type === 'offer') {
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            socket.emit('signal', { to: from, data: { description: pc.localDescription } })
          }
        } else if (data?.candidate) {
          if (pc.remoteDescription?.type) {
            await pc.addIceCandidate(data.candidate)
          } else {
            (pendingCandidatesRef.current[from] ||= []).push(data.candidate)
          }
        }
      } catch (err) { console.error('Signalling error:', err) }
    })
    return () => {
      Object.values(peersRef.current).forEach(pc => pc.close())
      socket.disconnect()
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

  // ---------------------------------------------------------------
  // LIVEKIT MEDIA SERVER (used when the backend says media = 'livekit')
  // Everyone sends their camera, microphone and shared screen to the media
  // server once, and the server sends them on to the others. The tiles still
  // get one MediaStream per person, so the rest of the page (tiles, recording,
  // zoom) works the same as with direct connections.
  // ---------------------------------------------------------------
  function disconnectLivekit() {
    const lk = lkRoomRef.current
    lkRoomRef.current = null
    lkTracksRef.current = {}
    screenPubRef.current = null
    // false = keep our own camera and microphone running (the caller decides when to stop them)
    if (lk) { try { lk.disconnect(false) } catch { /* already closed */ } }
    setLkState('off')
  }

  // One stream per person: their microphone, and their shared screen if they have
  // one, otherwise their camera.
  function rebuildLivekitStream(id) {
    const tracks = lkTracksRef.current[id] || {}
    const list = [tracks.mic, tracks.screen || tracks.camera].filter(Boolean)
    if (list.length) remoteStreamsRef.current[id] = new MediaStream(list)
    else delete remoteStreamsRef.current[id]
    setRemoteStreams({ ...remoteStreamsRef.current })
  }

  function livekitTrackChanged(id, source, mediaTrack) {
    const key = source === Track.Source.Microphone ? 'mic'
      : source === Track.Source.ScreenShare ? 'screen'
      : source === Track.Source.Camera ? 'camera' : null
    if (!key) return
    const tracks = (lkTracksRef.current[id] ||= {})
    if (mediaTrack) tracks[key] = mediaTrack
    else delete tracks[key]
    rebuildLivekitStream(id)
  }

  // Shared screens are sent in full detail (this is what makes zooming useful).
  async function publishScreenToLivekit(track) {
    const lk = lkRoomRef.current
    if (!lk) return
    try { track.contentHint = 'detail' } catch { /* not supported */ }
    screenPubRef.current = await lk.localParticipant.publishTrack(track, {
      source: Track.Source.ScreenShare,
      simulcast: false,
      videoEncoding: { maxBitrate: 4000000, maxFramerate: 15 }
    })
  }

  async function connectLivekit(payload) {
    if (!payload?.token) {
      setLkState('failed')
      flash(payload?.error || 'Could not get permission to use the video server.', 8000)
      return
    }
    disconnectLivekit()
    setLkState('connecting')
    const lk = new Room()
    lkRoomRef.current = lk
    const current = () => lkRoomRef.current === lk
    lk.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (current()) livekitTrackChanged(participant.identity, publication.source, track.mediaStreamTrack)
    })
    lk.on(RoomEvent.TrackUnsubscribed, (_track, publication, participant) => {
      if (current()) livekitTrackChanged(participant.identity, publication.source, null)
    })
    lk.on(RoomEvent.ParticipantDisconnected, participant => {
      if (!current()) return
      delete lkTracksRef.current[participant.identity]
      rebuildLivekitStream(participant.identity)
    })
    lk.on(RoomEvent.Disconnected, () => {
      if (!current()) return
      setLkState('failed')
      flash('Disconnected from the video server. Leave and join again to reconnect.', 8000)
    })
    try {
      await lk.connect(payload.url, payload.token)
      if (!current()) { lk.disconnect(false); return }
      setLkState('connected')
      // Send what we already have: microphone, camera and (if sharing) the screen.
      for (const track of streamRef.current?.getTracks() || []) {
        await lk.localParticipant.publishTrack(track, { source: track.kind === 'audio' ? Track.Source.Microphone : Track.Source.Camera })
      }
      const screenTrack = screenStreamRef.current?.getVideoTracks()[0]
      if (screenTrack) await publishScreenToLivekit(screenTrack)
    } catch (err) {
      console.error('LiveKit connection failed:', err)
      if (current()) {
        setLkState('failed')
        flash(`Could not connect to the video server (${err?.message || 'unknown error'}).`, 9000)
      }
    }
  }

  async function sendOffer(peerId, pc, options) {
    const offer = await pc.createOffer(options)
    await pc.setLocalDescription(offer)
    socketRef.current?.emit('signal', { to: peerId, data: { description: pc.localDescription } })
  }

  // peerId is always the other person's socket.id (the same ID used for
  // their participant entry and their tile), so streams land on the right tile.
  async function createPeer(peerId, initiator) {
    if (peersRef.current[peerId]) return peersRef.current[peerId]
    const pc = new RTCPeerConnection(iceConfig)
    peersRef.current[peerId] = pc
    setPeerStates(prev => ({ ...prev, [peerId]: 'connecting' }))

    const local = streamRef.current
    const audioTrack = local?.getAudioTracks()[0]
    const videoTrack = screenStreamRef.current?.getVideoTracks()[0] || local?.getVideoTracks()[0]
    if (audioTrack) pc.addTrack(audioTrack, local)
    if (videoTrack) pc.addTrack(videoTrack, local || screenStreamRef.current)
    // IMPORTANT: if this laptop has no camera/mic, the offer would contain no
    // audio/video sections at all, and the other person's video could never
    // arrive. "recvonly" sections make sure we can still RECEIVE.
    if (initiator) {
      if (!audioTrack) pc.addTransceiver('audio', { direction: 'recvonly' })
      if (!videoTrack) pc.addTransceiver('video', { direction: 'recvonly' })
    }

    pc.onicecandidate = e => {
      if (e.candidate) socketRef.current?.emit('signal', { to: peerId, data: { candidate: e.candidate } })
    }
    pc.ontrack = e => {
      // Build a fresh MediaStream for this peer: keep their other tracks and
      // replace any old track of the same kind (audio / video).
      const old = remoteStreamsRef.current[peerId]
      const keep = old ? old.getTracks().filter(track => track.kind !== e.track.kind) : []
      remoteStreamsRef.current[peerId] = new MediaStream([...keep, e.track])
      setRemoteStreams({ ...remoteStreamsRef.current })
    }
    let restarted = false
    pc.onconnectionstatechange = () => {
      if (peersRef.current[peerId] !== pc) return
      const state = pc.connectionState
      setPeerStates(prev => ({ ...prev, [peerId]: state }))
      if (state === 'failed') {
        // Try one ICE restart before giving up.
        if (initiator && !restarted) {
          restarted = true
          sendOffer(peerId, pc, { iceRestart: true }).catch(err => console.error('ICE restart failed:', err))
        }
        flash('Could not connect video with a participant. On some networks a TURN relay is required.', 6000)
      }
    }
    if (initiator) {
      try { await sendOffer(peerId, pc) } catch (err) { console.error('Offer failed:', err) }
    }
    return pc
  }

  async function refreshRecordings() {
    let shared = []
    const token = localStorage.getItem('cloudmeet-token')
    setRecordingsError('')
    if (token) {
      try {
        const data = await apiFetch('/api/recordings')
        shared = (data.recordings || []).map(item => ({ ...item, shared: true, url: `${API_URL}${item.url}?token=${encodeURIComponent(token)}` }))
      } catch (err) {
        console.warn('Could not load shared recordings', err)
        setRecordingsError(`Could not load shared recordings: ${err.message}`)
      }
      // Requests from people who want to watch recordings of meetings I host.
      try {
        const requestData = await apiFetch('/api/recordings/requests')
        setRecordingRequests(requestData.requests || [])
      } catch { setRecordingRequests([]) }
    }
    try {
      const local = await getRecordings()
      setRecordings([...shared, ...local.filter(item => !shared.some(remote => remote.id === item.id))].sort((a, b) => b.createdAt - a.createdAt))
    } catch (err) { console.warn('Could not read local recordings', err); setRecordings(shared) }
  }

  async function submitAuth(e) {
    e.preventDefault()
    setAuthError('')
    setAuthBusy(true)
    try {
      const response = await fetch(`${API_URL}/api/auth/${authMode === 'signup' ? 'signup' : 'login'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: authName, email: authEmail, password: authPassword })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not sign in. Check that the CloudMeet backend is running.')
      localStorage.setItem('cloudmeet-token', data.token)
      localStorage.setItem('cloudmeet-user', JSON.stringify(data.user))
      localStorage.setItem('cloudmeet-name', data.user.name)
      setCurrentUser(data.user)
      setName(data.user.name)
      setAuthPassword('')
      setScreen('home')
    } catch (error) {
      setAuthError(error.message || 'Could not connect to CloudMeet. Start the backend and try again.')
    } finally { setAuthBusy(false) }
  }

  function signOut(message = '') {
    localStorage.removeItem('cloudmeet-token')
    localStorage.removeItem('cloudmeet-user')
    setCurrentUser(null)
    setAuthMode('login')
    setAuthPassword('')
    setAuthError(typeof message === 'string' ? message : '')
    setScreen('auth')
  }

  // A student who missed the meeting enters its code to see its recordings.
  async function unlockRecordings(e, codeOverride) {
    e?.preventDefault?.()
    const code = cleanMeetingCode(codeOverride || recordingCode)
    setRecordingCodeMessage(''); setRecordingsError('')
    if (!code) { setRecordingsError('Enter the meeting code your host shared.'); return }
    setRecordingCodeBusy(true)
    try {
      const data = await apiFetch('/api/recordings/access', { method: 'POST', json: { code } })
      await refreshRecordings()
      setRecordingCode('')
      setRecordingCodeMessage(data.status === 'pending'
        ? `Request sent to ${data.meeting.hostName}. "${data.meeting.title}" will appear in your library once the host approves it.`
        : data.recordingCount
        ? `Added "${data.meeting.title}" (${data.meeting.id}) by ${data.meeting.hostName}: ${data.recordingCount} recording${data.recordingCount > 1 ? 's' : ''} now in your library.`
        : `"${data.meeting.title}" (${data.meeting.id}) has no recording yet. It will appear here automatically once the host records it.`)
    } catch (err) { setRecordingsError(err.message) } finally { setRecordingCodeBusy(false) }
  }

  // The host approves or declines someone who asked to watch recordings.
  async function answerRecordingRequest(request, decision) {
    setRecordingCodeMessage(''); setRecordingsError('')
    try {
      await apiFetch(`/api/recordings/requests/${request.meetingId}/${request.userId}/${decision}`, { method: 'POST' })
      setRecordingRequests(prev => prev.filter(item => !(item.meetingId === request.meetingId && item.userId === request.userId)))
      setRecordingCodeMessage(decision === 'approve' ? `${request.name} can now watch the recordings of "${request.title}".` : `The request from ${request.name} was declined.`)
    } catch (err) { setRecordingsError(err.message) }
  }

  function openMissedRecording(code) {
    clearInviteFromUrl(); setInviteRoom('')
    setScreen('recordings')
    unlockRecordings(null, code)
  }

  async function loadAttendance() {
    setAttendanceError('')
    try {
      const data = await apiFetch('/api/attendance')
      setAttendance(data.attendance || [])
    } catch (err) { setAttendanceError(err.message) }
  }

  function openProfile() {
    setProfileName(currentUser?.name || name || '')
    setCurrentPassword(''); setNewPassword(''); setConfirmPassword('')
    setProfileMessage(''); setProfileError('')
    setScreen('profile')
  }

  async function saveProfileName(e) {
    e.preventDefault()
    setProfileMessage(''); setProfileError(''); setProfileBusy(true)
    try {
      const data = await apiFetch('/api/auth/profile', { method: 'PUT', json: { name: profileName } })
      localStorage.setItem('cloudmeet-token', data.token)
      localStorage.setItem('cloudmeet-user', JSON.stringify(data.user))
      localStorage.setItem('cloudmeet-name', data.user.name)
      setCurrentUser(data.user); setName(data.user.name)
      setProfileMessage('Your name has been updated.')
    } catch (err) { setProfileError(err.message) } finally { setProfileBusy(false) }
  }

  async function savePassword(e) {
    e.preventDefault()
    setProfileMessage(''); setProfileError('')
    if (newPassword !== confirmPassword) { setProfileError('The new passwords do not match.'); return }
    setProfileBusy(true)
    try {
      await apiFetch('/api/auth/password', { method: 'PUT', json: { currentPassword, newPassword } })
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('')
      setProfileMessage('Your password has been changed.')
    } catch (err) { setProfileError(err.message) } finally { setProfileBusy(false) }
  }

  // ---------------------------------------------------------------
  // RECORDING OF THE WHOLE MEETING (replaces the old startRecording
  // and stopRecording). Everything visible is drawn onto one canvas:
  //  - no screen share: all camera tiles in a grid
  //  - someone shares: the shared screen is large, cameras in a side strip
  // The audio of everyone (and people who join later) is mixed in.
  // The drawing timer runs in a Web Worker, so the recording keeps going
  // when the host switches to another window while sharing.
  // ---------------------------------------------------------------
  async function startRecording() {
    if (!streamRef.current) {
      setNotice('Allow camera and microphone before starting a recording.')
      setTimeout(() => setNotice(''), 4000)
      return
    }
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
      setNotice('Recording is not supported by this browser. Try the latest Chrome or Edge.')
      setTimeout(() => setNotice(''), 5000)
      return
    }
    try {
      setRecordingBusy(true); setRecordingStatus('Starting…')
      const W = 1280, H = 720, PAD = 20, GAP = 12
      const canvas = document.createElement('canvas')
      canvas.width = W; canvas.height = H
      const ctx = canvas.getContext('2d')
      recordingCanvasRef.current = canvas

      // Hidden <video> elements used only for drawing (independent of the page layout).
      const feeds = new Map()
      const feedFor = (key, stream) => {
        let el = feeds.get(key)
        if (!el) {
          el = document.createElement('video')
          el.muted = true; el.playsInline = true; el.autoplay = true
          feeds.set(key, el)
        }
        if (el.srcObject !== stream) { el.srcObject = stream; el.play().catch(() => {}) }
        return el
      }
      const ready = el => el.readyState >= 2 && el.videoWidth > 0

      // Which videos exist right now? Read from refs so late joiners and new screen shares are picked up.
      const collectTiles = () => {
        const screens = [], cameras = []
        const myName = name || 'Guest'
        const mine = streamRef.current
        const myScreen = screenStreamRef.current
        if (myScreen) screens.push({ el: feedFor('me-screen', myScreen), label: `${myName} (screen)` })
        if (mine && mine.getVideoTracks().some(t => t.enabled && t.readyState === 'live')) {
          cameras.push({ el: feedFor('me', mine), label: `${myName} (You)` })
        }
        for (const person of participantsRef.current) {
          const stream = remoteStreamsRef.current[person.id]
          if (!stream || !stream.getVideoTracks().length) continue
          if (person.screenSharing) screens.push({ el: feedFor(person.id, stream), label: `${person.name || 'Participant'} (screen)` })
          else if (person.cameraOn !== false) cameras.push({ el: feedFor(person.id, stream), label: person.name || 'Participant' })
        }
        return { screens, cameras }
      }

      const drawTile = (el, x, y, w, h, label, contain) => {
        ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, w, h, 14); ctx.clip()
        ctx.fillStyle = '#0b1220'; ctx.fillRect(x, y, w, h)
        if (ready(el)) {
          const scale = contain ? Math.min(w / el.videoWidth, h / el.videoHeight) : Math.max(w / el.videoWidth, h / el.videoHeight)
          const dw = el.videoWidth * scale, dh = el.videoHeight * scale
          ctx.drawImage(el, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
        }
        ctx.restore()
        if (label) {
          ctx.font = '600 18px sans-serif'
          const tw = ctx.measureText(label).width + 20
          ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(x + 10, y + h - 38, tw, 28)
          ctx.fillStyle = '#ffffff'; ctx.fillText(label, x + 20, y + h - 18)
        }
      }
      const drawGrid = (items, x, y, w, h, contain) => {
        const n = items.length
        const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4
        const rows = Math.ceil(n / cols)
        const tw = (w - GAP * (cols - 1)) / cols, th = (h - GAP * (rows - 1)) / rows
        items.forEach((item, i) => drawTile(item.el, x + (i % cols) * (tw + GAP), y + Math.floor(i / cols) * (th + GAP), tw, th, item.label, contain))
      }
      const drawFrame = () => {
        ctx.fillStyle = '#101827'; ctx.fillRect(0, 0, W, H)
        const { screens, cameras } = collectTiles()
        if (screens.length) {
          const sideW = cameras.length ? 300 : 0
          const mainW = W - PAD * 2 - (sideW ? sideW + PAD : 0)
          drawGrid(screens, PAD, PAD, mainW, H - PAD * 2, true)
          if (sideW) {
            const n = cameras.length
            const th = Math.min(200, (H - PAD * 2 - GAP * (n - 1)) / n)
            cameras.forEach((cam, i) => drawTile(cam.el, W - PAD - sideW, PAD + i * (th + GAP), sideW, th, cam.label, false))
          }
        } else if (cameras.length) {
          drawGrid(cameras, PAD, PAD, W - PAD * 2, H - PAD * 2, false)
        } else {
          ctx.fillStyle = '#ffffff'; ctx.font = 'bold 36px sans-serif'; ctx.fillText('CloudMeet meeting', 48, 80)
          ctx.font = '24px sans-serif'; ctx.fillText(`Room ${room} · ${new Date().toLocaleString()}`, 48, 125)
        }
      }

      // Timer that is not slowed down in background tabs.
      let stopTicker
      try {
        const code = 'let t;onmessage=e=>{clearInterval(t);if(e.data)t=setInterval(()=>postMessage(0),e.data)}'
        const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })))
        worker.onmessage = drawFrame
        worker.postMessage(40)
        stopTicker = () => worker.terminate()
      } catch {
        const id = setInterval(drawFrame, 40)
        stopTicker = () => clearInterval(id)
      }
      drawFrame()

      // Mix the audio of everyone. Checked every second, so people who join later are included.
      const audioContext = new AudioContext()
      recordingAudioContextRef.current = audioContext
      audioContext.resume?.().catch(() => {})
      const destination = audioContext.createMediaStreamDestination()
      const connectedTracks = new Set()
      const syncAudio = () => {
        const streams = [streamRef.current, ...Object.values(remoteStreamsRef.current)]
        streams.forEach(stream => stream?.getAudioTracks().forEach(track => {
          if (connectedTracks.has(track.id) || track.readyState !== 'live') return
          connectedTracks.add(track.id)
          audioContext.createMediaStreamSource(new MediaStream([track])).connect(destination)
        }))
      }
      syncAudio()
      const audioTimer = setInterval(syncAudio, 1000)
      recordingStopDrawingRef.current = () => {
        stopTicker(); clearInterval(audioTimer)
        feeds.forEach(el => { el.srcObject = null }); feeds.clear()
      }

      const output = canvas.captureStream(25)
      destination.stream.getAudioTracks().forEach(track => output.addTrack(track))
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm'
      const recorder = new MediaRecorder(output, { mimeType, videoBitsPerSecond: 2500000 })
      recordingChunksRef.current = []
      recorder.ondataavailable = event => { if (event.data?.size) recordingChunksRef.current.push(event.data) }
      recorder.onerror = event => console.error('Recorder error:', event.error || event)
      recorder.onstop = async () => {
        recordingStopDrawingRef.current?.(); recordingStopDrawingRef.current = null
        socketRef.current?.emit('recording-state', { recording: false })
        setRecordingBusy(true); setRecordingStatus('Saving recording…')
        try {
          const blob = new Blob(recordingChunksRef.current, { type: 'video/webm' })
          recordingChunksRef.current = []
          if (!blob.size) { setNotice('Nothing was recorded.'); return }
          const item = {
            id: `${Date.now()}-${room}`, title: meetingTitle || `Meeting ${room}`, room, createdAt: Date.now(),
            durationSeconds: Math.max(1, Math.round((Date.now() - (recorder.startedAt || Date.now())) / 1000)), blob
          }
          const token = localStorage.getItem('cloudmeet-token')
          let uploaded = false, reason = 'You are not signed in.'
          if (token) {
            // Try the shared upload first (twice), and only then keep a copy in this browser.
            for (let attempt = 1; attempt <= 2 && !uploaded; attempt++) {
              try {
                setRecordingStatus(attempt === 1 ? 'Uploading recording…' : 'Retrying upload…')
                const form = new FormData()
                form.append('title', item.title)
                form.append('room', room)
                form.append('durationSeconds', String(item.durationSeconds))
                form.append('video', new File([blob], `cloudmeet-${room}.webm`, { type: 'video/webm' }))
                const response = await fetch(`${API_URL}/api/recordings`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
                const data = await response.json().catch(() => ({}))
                if (!response.ok) throw new Error(data.error || `Upload failed (${response.status})`)
                uploaded = true
              } catch (uploadError) {
                reason = uploadError.message || 'Upload failed.'
                console.error(`Recording upload attempt ${attempt} failed:`, uploadError)
              }
            }
          }
          if (uploaded) {
            setNotice('Recording saved. Everyone who attended this meeting can watch it under Recordings.')
          } else {
            try {
              await saveRecording(item)
              setNotice(`Saved only in this browser because the upload failed (${reason}).`)
            } catch (storeError) {
              console.error(storeError)
              setNotice(`The recording could not be saved (${reason}).`)
            }
          }
          await refreshRecordings()
        } catch (err) {
          console.error(err)
          setNotice('The recording could not be saved.')
        } finally {
          recordingAudioContextRef.current?.close().catch(() => {})
          recordingAudioContextRef.current = null
          recorderRef.current = null
          setRecordingActive(false); setRecordingBusy(false); setRecordingStatus('')
          setTimeout(() => setNotice(''), 8000)
        }
      }
      recorder.startedAt = Date.now()
      recorder.start(1000)
      recorderRef.current = recorder
      setRecordingActive(true); setRecordingBusy(false); setRecordingStatus('')
      // Tell everyone in the room that the meeting is being recorded.
      socketRef.current?.emit('recording-state', { recording: true })
      setNotice('Recording started. Keep this meeting tab open until you stop recording.')
      setTimeout(() => setNotice(''), 4000)
    } catch (err) {
      console.error('Recording error:', err)
      recordingStopDrawingRef.current?.(); recordingStopDrawingRef.current = null
      recordingAudioContextRef.current?.close().catch(() => {}); recordingAudioContextRef.current = null
      setNotice('Could not start recording. Check browser permissions and try again.')
      setRecordingBusy(false); setRecordingStatus('')
      setTimeout(() => setNotice(''), 5000)
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      // Update the button and the banner straight away; the upload continues in the background.
      setRecordingBusy(true); setRecordingStatus('Saving recording…')
      socketRef.current?.emit('recording-state', { recording: false })
      try { recorder.stop() } catch (err) { console.error('Could not stop recorder:', err) }
      return
    }
    // The recorder is not running any more: reset a stuck button.
    recordingStopDrawingRef.current?.(); recordingStopDrawingRef.current = null
    socketRef.current?.emit('recording-state', { recording: false })
    setRecordingActive(false); setRecordingBusy(false); setRecordingStatus('')
  }

  async function openRecording(item) {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl)
    setRecordingUrl(item.url ? item.url : URL.createObjectURL(item.blob))
    // Tell the server this person watched it (the host sees the list).
    if (item.shared) apiFetch(`/api/recordings/${encodeURIComponent(item.id)}/view`, { method: 'POST' }).catch(err => console.warn('View not saved:', err.message))
  }

  // Host only: show who watched a recording (name and date).
  async function toggleViewers(item) {
    if (viewersFor === item.id) { setViewersFor(null); return }
    setViewersFor(item.id); setViewersList(null); setViewersError('')
    try {
      const data = await apiFetch(`/api/recordings/${encodeURIComponent(item.id)}/viewers`)
      setViewersList(data.viewers || [])
    } catch (err) { setViewersError(err.message) }
  }

  async function removeRecording(id) {
    if (!window.confirm('Delete this recording?')) return
    try {
      const item = recordings.find(record => record.id === id)
      if (item?.shared) await apiFetch(`/api/recordings/${encodeURIComponent(id)}`, { method: 'DELETE' })
      else await deleteRecording(id)
      if (recordingUrl) { URL.revokeObjectURL(recordingUrl); setRecordingUrl('') }
      await refreshRecordings()
    } catch (err) { setRecordingsError(`Could not delete this recording: ${err.message}`) }
  }

  async function startMeeting(code, host = false) {
    if (meetingBusy) return
    // 1. Ask the server to create the meeting (host), or check the code (join).
    let finalCode, title, access = 'ask'
    setMeetingBusy(true)
    try {
      if (host) {
        if (newAccessType === 'invite' && !newInvitedEmails.trim()) throw new Error('Type at least one email address for an invite-only meeting.')
        const data = await apiFetch('/api/meetings', { method: 'POST', json: { title: newMeetingTitle, accessType: newAccessType, invitedEmails: newInvitedEmails } })
        finalCode = data.meeting.id; title = data.meeting.title; access = data.meeting.accessType || 'ask'
      } else {
        const wanted = cleanMeetingCode(code)
        if (!wanted) throw new Error('Please enter a meeting code first.')
        const data = await apiFetch(`/api/meetings/${wanted}`)
        finalCode = data.meeting.id; title = data.meeting.title; access = data.meeting.accessType || 'ask'
      }
    } catch (err) {
      flash(err.message, 6000)
      setMeetingBusy(false)
      return
    }
    setMeetingBusy(false)
    clearInviteFromUrl(); setInviteRoom('')
    setMeetingTitle(title || 'Team meeting')
    setMeetingAccess(access)
    setNewMeetingTitle(''); setNewAccessType('ask'); setNewInvitedEmails('')
    setWaitingForHost(false); setJoinRequests([]); joinRequestIdsRef.current = new Set()

    // 2. Start camera/microphone, then join the live room.
    setIsHost(false) // confirmed by the server in 'room-state'
    setRoomRecording(false)
    setParticipants([])
    removeAllPeers()
    mediaModeRef.current = 'p2p'
    const cleanName = name.trim() || 'Guest'
    setName(cleanName)
    localStorage.setItem('cloudmeet-name', cleanName)
    setRoom(finalCode)
    meetingStartedAtRef.current = Date.now()
    setMeetingCode(finalCode)
    setMessages([])
    setNotice('')
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        const error = new Error('Camera access needs HTTPS. Open the https:// address of CloudMeet.')
        error.name = window.isSecureContext ? 'NotSupportedError' : 'InsecurePage'
        throw error
      }
      let stream
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: { echoCancellation: true, noiseSuppression: true } }) }
      catch (bothError) {
        console.warn('Combined camera/microphone request failed:', bothError)
        let videoStream = null, audioStream = null
        try { videoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }) } catch (e) { console.warn('Camera request failed:', e) }
        try { audioStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true }) } catch (e) { console.warn('Microphone request failed:', e) }
        if (videoStream && audioStream) { audioStream.getAudioTracks().forEach(track => videoStream.addTrack(track)); stream = videoStream }
        else stream = videoStream || audioStream
        if (!stream) throw bothError
      }
      streamRef.current = stream
      setLocalStream(stream)
      setMicOn(stream.getAudioTracks().some(track => track.enabled)); setCameraOn(stream.getVideoTracks().some(track => track.enabled))
    } catch (err) {
      console.error('Media startup failed:', err?.name, err?.message, err)
      setMicOn(false); setCameraOn(false); setLocalStream(null)
      if (err?.name === 'InsecurePage') flash('Camera and microphone are blocked because this page is not HTTPS. Open https://<host-laptop-IP>:5173 instead. You can still see and hear others.', 10000)
      else flash(`Camera/microphone could not start (${err?.name || 'device error'}). Check browser site permissions and Windows privacy settings. You can still see and hear others.`, 8000)
    }
    // Join only after media is ready, so our tracks go into every connection.
    joinInfoRef.current = { room: finalCode, name: cleanName, host }
    if (socketRef.current?.connected) emitJoin()
    else flash('Waiting for the meeting server… you will join automatically.', 5000)
    setJoined(true)
    setScreen('meeting')
  }

  // Host: let a waiting person in, or keep them out.
  function answerJoin(eventName, id) {
    socketRef.current?.emit(eventName, { id })
    setJoinRequests(prev => prev.filter(person => person.id !== id))
  }
  function admitEveryone() {
    joinRequests.forEach(person => socketRef.current?.emit('admit-user', { id: person.id }))
    setJoinRequests([])
  }
  // Host: remove someone who is already in the meeting.
  function removePerson(person) {
    if (!window.confirm(`Remove ${person.name || 'this person'} from the meeting?`)) return
    socketRef.current?.emit('remove-user', { id: person.id })
  }

  function sendMediaState() {
    socketRef.current?.emit('media-state', currentMediaState())
  }

  function toggleMic() {
    const tracks = streamRef.current?.getAudioTracks() || []
    if (!tracks.length) { flash('No microphone is available on this device or permission was denied.'); return }
    const next = !micOn
    tracks.forEach(t => { t.enabled = next })
    setMicOn(next)
    sendMediaState()
  }
  function toggleCamera() {
    const tracks = streamRef.current?.getVideoTracks() || []
    if (!tracks.length) { flash('No camera is available on this device or permission was denied.'); return }
    const next = !cameraOn
    tracks.forEach(t => { t.enabled = next })
    setCameraOn(next)
    sendMediaState()
  }

  // Find the video "slot" in a connection. It may have a track (camera) or be
  // an empty receive-only slot if this laptop had no camera.
  function findVideoTransceiver(pc) {
    return pc.getTransceivers().find(t => !t.stopped && t.mid !== null && (t.sender.track?.kind === 'video' || t.receiver.track?.kind === 'video'))
  }

  async function shareScreen() {
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) { flash('Screen sharing requires a supported browser on HTTPS.', 4500); return }
      // Ask for the full detail of the screen (up to 4K) so zooming in shows real, readable text.
      const display = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 15, max: 30 } }, audio: false })
      const screenTrack = display.getVideoTracks()[0]
      if (!screenTrack) return
      // "detail" tells the browser to keep text sharp instead of keeping motion smooth.
      try { screenTrack.contentHint = 'detail' } catch {}
      screenStreamRef.current = display
      setScreenStream(display)
      // With the media server, the screen is published as its own track.
      if (mediaModeRef.current === 'livekit') {
        screenTrack.onended = () => stopScreenShare()
        try { await publishScreenToLivekit(screenTrack) } catch (error) { console.warn('Could not publish the screen:', error) }
        sendMediaState()
        flash('You are presenting your screen to everyone.', 4500)
        return
      }
      let sent = 0
      for (const [peerId, pc] of Object.entries(peersRef.current)) {
        try {
          const sender = pc.getSenders().find(item => item.track?.kind === 'video')
          if (sender) { await sender.replaceTrack(screenTrack); await tuneVideoSender(sender, true); sent++; continue }
          // No camera was being sent: turn the receive-only video slot into
          // send+receive and renegotiate with this peer.
          const transceiver = findVideoTransceiver(pc)
          if (transceiver) { transceiver.direction = 'sendrecv'; await transceiver.sender.replaceTrack(screenTrack) }
          else pc.addTrack(screenTrack, display)
          await sendOffer(peerId, pc)
          const newSender = pc.getSenders().find(item => item.track === screenTrack)
          if (newSender) await tuneVideoSender(newSender, true)
          sent++
        } catch (error) { console.warn('Could not share screen with', peerId, error) }
      }
      screenTrack.onended = () => stopScreenShare()
      sendMediaState()
      flash(sent ? 'You are presenting your screen to everyone.' : 'Screen sharing started. Participants who join will see it.', 4500)
    } catch (err) {
      console.error('Screen share error:', err?.name, err?.message, err)
      if (!['AbortError', 'NotAllowedError'].includes(err?.name)) { setNotice(`Could not start screen sharing (${err?.name || 'unknown error'}).`); setTimeout(() => setNotice(''), 5000) }
    }
  }
  async function stopScreenShare() {
    const display = screenStreamRef.current
    if (!display) return
    if (mediaModeRef.current === 'livekit') {
      const published = screenPubRef.current
      screenPubRef.current = null
      try { if (published?.track) await lkRoomRef.current?.localParticipant.unpublishTrack(published.track, false) } catch (error) { console.warn('Could not stop the shared screen:', error) }
    }
    const screenTrack = display.getVideoTracks()[0]
    const cameraTrack = streamRef.current?.getVideoTracks()[0] || null
    await Promise.all(Object.values(peersRef.current).map(async pc => {
      const sender = pc.getSenders().find(item => item.track && item.track === screenTrack)
      if (sender) {
        try { await sender.replaceTrack(cameraTrack); await tuneVideoSender(sender, false) } catch (error) { console.warn('Could not restore camera track:', error) }
      }
    }))
    display.getTracks().forEach(track => track.stop())
    screenStreamRef.current = null
    setScreenStream(null)
    sendMediaState()
  }

  function sendMessage(e) {
    e.preventDefault()
    const text = chatInput.trim()
    if (!text || !socketRef.current) return
    socketRef.current.emit('chat-message', { room, message: text, name: name || 'Guest' })
    setChatInput('')
  }
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(room)
      setCopied('code'); setTimeout(() => setCopied(false), 1600)
    } catch { flash(`Meeting code: ${room}`) }
  }
  async function copyInviteLink() {
    const link = `${window.location.origin}/?room=${room}`
    try {
      await navigator.clipboard.writeText(link)
      setCopied('link'); setTimeout(() => setCopied(false), 1600)
      flash('Invite link copied. Send it to participants on the same network.', 3500)
    } catch { flash(`Invite link: ${link}`, 8000) }
  }
  function leaveMeeting() {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.addEventListener('stop', () => finishLeaveMeeting(), { once: true })
      recorderRef.current.stop()
      setNotice('Saving recording before leaving…')
      return
    }
    finishLeaveMeeting()
  }

  function finishLeaveMeeting() {
    // The server records the leave time for attendance.
    socketRef.current?.emit('leave-room', { room })
    meetingStartedAtRef.current = null
    joinInfoRef.current = null
    removeAllPeers()
    streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null; setLocalStream(null)
    screenStreamRef.current?.getTracks().forEach(t => t.stop()); screenStreamRef.current = null; setScreenStream(null)
    setIsHost(false); setRoomRecording(false)
    setWaitingForHost(false); setJoinRequests([]); joinRequestIdsRef.current = new Set()
    setParticipants([]); setJoined(false); setChatOpen(false); setPeopleOpen(false); setScreen('home')
  }

  if (screen === 'auth') return <div className="auth-page">
    <div className="auth-side">
      <a className="brand auth-brand" href="#" onClick={e => e.preventDefault()}><span className="brand-icon"><Video size={20}/></span><span>Cloud<span className="brand-blue">Meet</span></span></a>
      <div className="auth-pitch"><span className="announcement"><Sparkles size={14}/> SIMPLE. CONNECTED. PRODUCTIVE.</span><h1>Bring everyone<br/>into <span>one room.</span></h1><p>Meet, share ideas, and stay connected with your team from anywhere.</p><div className="auth-benefit"><ShieldCheck size={18}/><span><b>Your own account</b><small>Your meeting profile is saved for next time.</small></span></div><div className="auth-benefit"><Users size={18}/><span><b>Made for teamwork</b><small>Join a meeting with a simple room code.</small></span></div></div>
      <div className="auth-side-foot">CloudMeet · Student project prototype</div>
    </div>
    <div className="auth-main"><form className="auth-card" onSubmit={submitAuth}>
      <span className="eyebrow">WELCOME TO CLOUDMEET</span><h2>{authMode === 'signup' ? 'Create your account' : 'Welcome back'}</h2><p className="auth-subtitle">{authMode === 'signup' ? 'Sign up to start joining and hosting meetings.' : 'Sign in to continue to your meetings.'}</p>
      {inviteRoom && <div className="invite-hint"><Link2 size={15}/> Sign in to join meeting <b>{inviteRoom}</b>.</div>}
      {authError && <div className="auth-error" role="alert">{authError}</div>}
      {authMode === 'signup' && <label className="auth-label">Full name<input autoComplete="name" value={authName} onChange={e => setAuthName(e.target.value)} placeholder="Enter your name" minLength={2} maxLength={80} required /></label>}
      <label className="auth-label">Email address<input type="email" autoComplete="email" value={authEmail} onChange={e => setAuthEmail(e.target.value)} placeholder="you@example.com" required /></label>
      <label className="auth-label">Password<input type="password" autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'} value={authPassword} onChange={e => setAuthPassword(e.target.value)} placeholder={authMode === 'signup' ? 'At least 8 characters' : 'Enter your password'} minLength={authMode === 'signup' ? 8 : undefined} required /></label>
      <button className="button button-primary full auth-submit" type="submit" disabled={authBusy}>{authBusy ? 'Please wait…' : authMode === 'signup' ? 'Create account' : 'Sign in'} <ArrowRight size={16}/></button>
      <p className="auth-switch">{authMode === 'signup' ? 'Already have an account?' : "Don't have an account?"} <button type="button" onClick={() => { setAuthMode(authMode === 'signup' ? 'login' : 'signup'); setAuthError('') }}>{authMode === 'signup' ? 'Sign in' : 'Sign up'}</button></p>
      <p className="auth-footnote">Your account is stored securely in the CloudMeet cloud database (Google Cloud SQL).</p>
    </form></div>
  </div>

  if (screen === 'meeting') {
    // Grid grows with the number of tiles: 1-2 → 2 columns, 3-4 → 2, 5-9 → 3.
    const tileCount = participants.length + 1 + (participants.length === 0 ? 1 : 0)
    const gridColumns = tileCount <= 1 ? 1 : tileCount <= 4 ? 2 : tileCount <= 9 ? 3 : 4
    const connectionLabel = id => ({
      connected: 'Connected',
      connecting: 'Connecting…',
      new: 'Connecting…',
      disconnected: 'Connection unstable…',
      failed: 'Video connection failed',
      closed: 'Disconnected'
    }[peerStates[id]] || 'Joined')
    const tileStatus = (id, stream) => {
      if (mediaModeRef.current === 'livekit') {
        if (lkState === 'failed') return 'Video connection failed'
        if (lkState !== 'connected' && !stream) return 'Connecting…'
        return ''
      }
      const state = peerStates[id]
      if (state === 'failed') return 'Video connection failed'
      if (state === 'disconnected') return 'Reconnecting…'
      if (!stream && state !== 'connected') return 'Connecting…'
      return ''
    }
    return <div className="meeting-app">
      <header className="meeting-header">
        <a className="brand compact" href="#" onClick={e => { e.preventDefault(); leaveMeeting() }}><span className="brand-icon"><Video size={19}/></span><span>Cloud<span className="brand-blue">Meet</span></span></a>
        <div className="room-info"><span className="live-dot" /> Meeting <b>{room}</b><button className="icon-button small" onClick={copyCode} title="Copy meeting code">{copied === 'code' ? <Check size={15}/> : <Copy size={15}/>}</button><button className="icon-button small" onClick={copyInviteLink} title="Copy invite link">{copied === 'link' ? <Check size={15}/> : <Link2 size={15}/>}</button></div>
        <div className="header-right"><span className="connection-status">{status}</span><span className="people-count"><Users size={16}/>{participants.length + 1}</span></div>
      </header>
      {notice && <div className="toast">{notice}</div>}
      {waitingForHost && <div className="waiting-overlay" role="alertdialog" aria-live="polite"><div className="waiting-card"><div className="waiting-icon"><Clock size={26}/></div><h2>Asking to join…</h2><p>The host of <b>{meetingTitle}</b> has been told you are here. You will enter as soon as they let you in.</p><button className="button button-outline" onClick={leaveMeeting}>Cancel</button></div></div>}
      {isHost && joinRequests.length > 0 && <div className="join-requests" role="dialog" aria-label="People waiting to join"><div className="join-requests-title"><b>Waiting to join</b><span>{joinRequests.length}</span></div>{joinRequests.map(person => <div className="join-request" key={person.id}><div className="chat-avatar">{initials(person.name)}</div><span className="join-request-name">{person.name}</span><button className="button button-primary" onClick={() => answerJoin('admit-user', person.id)}>Admit</button><button className="button button-outline" onClick={() => answerJoin('deny-user', person.id)}>Deny</button></div>)}{joinRequests.length > 1 && <button className="button button-light full" onClick={admitEveryone}>Admit all</button>}</div>}
      <main className={`meeting-main ${chatOpen ? 'with-chat' : ''}`}>
        <section className="video-stage">
          <div className="stage-topline"><div><span className="eyebrow">LIVE SESSION</span><h1>{meetingTitle}</h1></div><div className="stage-badges"><span className="secure-badge"><Lock size={14}/> {meetingAccess === 'invite' ? 'Invite-only meeting' : 'Host approves joiners'}</span><span className="secure-badge"><Users size={14}/>{participants.length + 1} participant{participants.length ? 's' : ''}</span></div></div>
          <section aria-label="Meeting participants" style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',padding:'10px 12px',margin:'0 0 12px',border:'1px solid #e5e7eb',borderRadius:12,background:'#fff'}}>
            <button type="button" onClick={() => setPeopleOpen(v => !v)} aria-expanded={peopleOpen} style={{border:0,background:'transparent',fontWeight:700,fontSize:13,color:'#374151',cursor:'pointer',padding:'5px 0'}}>People ({participants.length + 1})</button>
            <span style={{display:'inline-flex',alignItems:'center',gap:7,padding:'6px 10px',borderRadius:999,background:'#eff6ff',color:'#1d4ed8',fontSize:13}}>
              <span style={{display:'inline-grid',placeItems:'center',width:24,height:24,borderRadius:'50%',background:'#dbeafe',fontWeight:700}}>{(name || 'G').trim().charAt(0).toUpperCase()}</span>
              {name || 'Guest'} (You)
            </span>
            {participants.map(person => <span key={person.id} style={{display:'inline-flex',alignItems:'center',gap:7,padding:'6px 10px',borderRadius:999,background:'#f3f4f6',color:'#374151',fontSize:13}}>
              <span style={{display:'inline-grid',placeItems:'center',width:24,height:24,borderRadius:'50%',background:'#e5e7eb',fontWeight:700}}>{(person.name || 'G').trim().charAt(0).toUpperCase()}</span>
              {person.name || 'Participant'}
            </span>)}
          </section>
          {roomRecording && <div className="recording-banner" role="status"><span className="rec-dot"/> This meeting is being recorded</div>}
          <div className={`video-grid cols-${gridColumns}`}>
            <VideoTile
              isLocal muted mirror={!screenStream}
              stream={screenStream || localStream}
              showVideo={Boolean(screenStream) || (cameraOn && Boolean(localStream?.getVideoTracks().length))}
              name={name || 'Guest'} micOn={micOn} isHost={isHost} presenting={Boolean(screenStream)}
            />
            {participants.map(person => {
              const stream = remoteStreams[person.id] || null
              const hasVideo = Boolean(stream?.getVideoTracks().length)
              const showVideo = hasVideo && (person.screenSharing || person.cameraOn !== false)
              return <VideoTile
                key={person.id}
                stream={stream}
                name={person.name || 'Participant'}
                showVideo={showVideo}
                micOn={person.micOn !== false}
                isHost={person.isHost}
                presenting={person.screenSharing}
                status={tileStatus(person.id, stream)}
              />
            })}
            {participants.length === 0 && <div className="empty-tile"><div className="empty-icon"><Users size={27}/></div><h3>Waiting for others to join</h3><p>Share the invite link or meeting code so your team can join.</p><div className="empty-actions"><button className="button button-primary" onClick={copyInviteLink}><Link2 size={15}/>{copied === 'link' ? 'Copied!' : 'Copy invite link'}</button><button className="button button-light" onClick={copyCode}><Copy size={15}/>{copied === 'code' ? 'Copied!' : 'Copy code'}</button></div></div>}
          </div>
          <div className="control-dock">
            <div className="control-group">
              <button className={`control ${!micOn ? 'off' : ''}`} onClick={toggleMic}><span>{micOn ? <Mic/> : <MicOff/>}</span><small>{micOn ? 'Mute' : 'Unmute'}</small></button>
              <button className={`control ${!cameraOn ? 'off' : ''}`} onClick={toggleCamera}><span>{cameraOn ? <Video/> : <VideoOff/>}</span><small>{cameraOn ? 'Stop video' : 'Start video'}</small></button>
              <button className={`control ${screenStream ? 'selected' : ''}`} onClick={screenStream ? stopScreenShare : shareScreen}><span><MonitorUp/></span><small>{screenStream ? 'Stop sharing' : 'Share screen'}</small></button>
              {isHost && <button className={`control ${recordingActive ? 'recording-control' : ''}`} onClick={recordingActive ? stopRecording : startRecording} disabled={recordingBusy}><span>{recordingActive ? <Square/> : <Circle/>}</span><small>{recordingBusy ? (recordingStatus || 'Please wait…') : recordingActive ? 'Stop recording' : 'Record'}</small></button>}
              <button className={`control ${peopleOpen ? 'selected' : ''}`} onClick={() => setPeopleOpen(v => !v)}><span><Users/></span><small>People</small><i className="message-badge">{participants.length + 1}</i></button>
              <button className={`control ${chatOpen ? 'selected' : ''}`} onClick={() => setChatOpen(!chatOpen)}><span><MessageCircle/></span><small>Chat</small>{messages.length > 0 && <i className="message-badge">{messages.length}</i>}</button>
            </div>
            <button className="leave-button" onClick={leaveMeeting}><PhoneOff size={18}/><span>Leave</span></button>
          </div>
        </section>
        {peopleOpen && <aside className="chat-panel people-panel">
          <div className="chat-heading"><div><h2>People</h2><p>{participants.length + 1} {participants.length ? 'people' : 'person'} in this meeting</p></div><button className="icon-button" onClick={() => setPeopleOpen(false)} aria-label="Close people panel"><X size={18}/></button></div>
          <div className="chat-messages">
            <div className="chat-message person-row"><div className="chat-avatar">{initials(name || 'Guest')}</div><div className="person-info"><div className="chat-meta"><b>{name || 'Guest'} (You)</b>{isHost && <span className="host-chip light">Host</span>}</div><p>{screenStream ? 'Presenting' : 'In the meeting'}</p></div><div className="person-icons">{micOn ? <Mic size={15}/> : <MicOff size={15} className="icon-off"/>}{cameraOn ? <Video size={15}/> : <VideoOff size={15} className="icon-off"/>}</div></div>
            {participants.map(person => <div className="chat-message person-row" key={person.id}><div className="chat-avatar">{initials(person.name || 'Participant')}</div><div className="person-info"><div className="chat-meta"><b>{person.name || 'Participant'}</b>{person.isHost && <span className="host-chip light">Host</span>}</div><p>{person.screenSharing ? 'Presenting' : connectionLabel(person.id)}</p></div><div className="person-icons">{person.micOn !== false ? <Mic size={15}/> : <MicOff size={15} className="icon-off"/>}{person.cameraOn !== false ? <Video size={15}/> : <VideoOff size={15} className="icon-off"/>}{isHost && <button type="button" className="icon-button small remove-person" title="Remove from meeting" aria-label={`Remove ${person.name || 'participant'}`} onClick={() => removePerson(person)}><UserX size={14}/></button>}</div></div>)}
          </div>
        </aside>}
        {chatOpen && <aside className="chat-panel">
          <div className="chat-heading"><div><h2>Meeting chat</h2><p>Messages for everyone in this room</p></div><button className="icon-button" onClick={() => setChatOpen(false)}><X size={18}/></button></div>
          <div className="chat-messages">{messages.map((m, i) => <div className="chat-message" key={m.id || i}><div className="chat-avatar">{(m.name || 'G').charAt(0).toUpperCase()}</div><div><div className="chat-meta"><b>{m.name}</b><span>{new Date(m.time || Date.now()).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span></div><p>{m.message}</p></div></div>)}{messages.length === 0 && <div className="chat-empty"><MessageCircle size={25}/><b>No messages yet</b><span>Start the conversation.</span></div>}</div>
          <form className="chat-form" onSubmit={sendMessage}><input value={chatInput} onChange={e => setChatInput(e.target.value)} placeholder="Write a message…" aria-label="Write a message"/><button type="submit" aria-label="Send message"><Send size={17}/></button></form>
        </aside>}
      </main>
      <footer className="meeting-footer"><span>CloudMeet</span><span>Connect. Collaborate. Anywhere.</span><span>Demo prototype</span></footer>
    </div>
  }

  const totalMinutes = attendance.reduce((sum, item) => sum + (item.durationMinutes || 0), 0)
  const uniqueMeetings = attendance.length

  if (screen === 'attendance') return <div className="home-app">
    <header className="site-header">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setScreen('home') }}><span className="brand-icon"><Video size={20}/></span><span>Cloud<span className="brand-blue">Meet</span></span></a>
      <nav><a href="#attendance-summary">Overview</a><a href="#attendance-history">Meeting history</a></nav>
      <button className="button button-outline" onClick={() => setScreen('home')}><ArrowRight size={16}/> Back to meetings</button>
    </header>
    <main className="attendance-page">
      <div className="attendance-heading"><span className="eyebrow">YOUR ACTIVITY</span><h1>Attendance dashboard</h1><p>Review your CloudMeet sessions and the time you spent in meetings.</p></div>
      <div className="attendance-stats" id="attendance-summary">
        <article className="attendance-stat"><span className="attendance-stat-icon"><CalendarCheck size={20}/></span><p>Meetings attended</p><strong>{uniqueMeetings}</strong><small>Saved on the CloudMeet server for your account</small></article>
        <article className="attendance-stat"><span className="attendance-stat-icon violet"><Clock size={20}/></span><p>Total time in meetings</p><strong>{totalMinutes} <em>min</em></strong><small>Based on join and leave time</small></article>
        <article className="attendance-stat"><span className="attendance-stat-icon teal"><BarChart3 size={20}/></span><p>Average session</p><strong>{uniqueMeetings ? Math.round(totalMinutes / uniqueMeetings) : 0} <em>min</em></strong><small>Across your recorded sessions</small></article>
      </div>
      <section className="attendance-history" id="attendance-history"><div className="attendance-history-title"><div><span className="eyebrow">RECENT ACTIVITY</span><h2>Meeting history</h2></div><button className="button button-outline" onClick={loadAttendance}><History size={16}/> Refresh</button></div>
        {attendanceError && <div className="auth-error page-error" role="alert">{attendanceError}</div>}
        {attendance.length ? <div className="attendance-table-wrap"><table className="attendance-table"><thead><tr><th>Meeting</th><th>Code</th><th>Your name</th><th>Role</th><th>Date</th><th>Joined</th><th>Duration</th><th>People</th></tr></thead><tbody>{attendance.map(item => <tr key={item.id}><td><b>{item.title}</b></td><td><span className="meeting-code-pill">{item.room}</span></td><td>{item.name}</td><td>{item.role}</td><td>{new Date(item.joinedAt).toLocaleDateString()}</td><td>{new Date(item.joinedAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</td><td>{item.leftAt ? `${item.durationMinutes} min` : <span className="attendance-present">In progress</span>}</td><td>{item.participantCount}</td></tr>)}</tbody></table></div> : <div className="attendance-empty"><History size={30}/><h3>No attendance records yet</h3><p>Join or create a meeting, then leave it to see your session here.</p><button className="button button-primary" onClick={() => { setScreen('home'); setTimeout(() => document.getElementById('start-panel')?.scrollIntoView({behavior:'smooth'}), 0) }}>Start a meeting <ArrowRight size={16}/></button></div>}
      </section>
      <p className="attendance-disclaimer">Attendance is saved by the CloudMeet backend each time you join or leave a meeting, so you see the same history on any device. In the cloud version this data moves to Cloud SQL (MySQL).</p>
    </main>
  </div>

  if (screen === 'recordings') return <div className="home-app">
    <header className="site-header">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setScreen('home') }}><span className="brand-icon"><Video size={20}/></span><span>Cloud<span className="brand-blue">Meet</span></span></a>
      <nav><a href="#recording-list">Saved videos</a></nav>
      <button className="button button-outline" onClick={() => setScreen('home')}><ArrowRight size={16}/> Back to meetings</button>
    </header>
    <main className="attendance-page recordings-page">
      <div className="attendance-heading"><span className="eyebrow">MEETING LIBRARY</span><h1>Recordings</h1><p>Recordings of meetings you hosted or attended, and of meetings you added with a code.</p></div>
      <form className="attendance-history missed-form" onSubmit={unlockRecordings}>
        <div><span className="eyebrow">MISSED A MEETING?</span><h2>Ask the host for a recording</h2><p>Enter the meeting code your host shared. The host must approve your request before you can watch anything.</p></div>
        <div className="missed-input"><input value={recordingCode} onChange={e => setRecordingCode(cleanMeetingCode(e.target.value))} placeholder="e.g. A1B2C3" maxLength={12} aria-label="Meeting code"/><button className="button button-primary" type="submit" disabled={recordingCodeBusy}>{recordingCodeBusy ? 'Sending…' : 'Request access'}</button></div>
      </form>
      {recordingRequests.length > 0 && <section className="attendance-history access-requests"><div><span className="eyebrow">ACCESS REQUESTS</span><h2>People asking to watch your recordings</h2></div>{recordingRequests.map(request => <div className="access-request" key={`${request.meetingId}-${request.userId}`}><div className="access-request-info"><b>{request.name}</b><span>wants to watch “{request.title}” (meeting {request.meetingId})</span></div><div className="access-request-actions"><button className="button button-primary" onClick={() => answerRecordingRequest(request, 'approve')}>Approve</button><button className="button button-outline" onClick={() => answerRecordingRequest(request, 'deny')}>Decline</button></div></div>)}</section>}
      {recordingCodeMessage && <div className="profile-success" role="status"><Check size={16}/> {recordingCodeMessage}</div>}
      {recordingsError && <div className="auth-error page-error" role="alert">{recordingsError}</div>}
      {recordingUrl && <section className="recording-player"><div className="attendance-history-title"><h2>Preview recording</h2><button className="button button-outline" onClick={() => { URL.revokeObjectURL(recordingUrl); setRecordingUrl('') }}>Close player</button></div><video controls autoPlay src={recordingUrl}/></section>}
      <section className="attendance-history" id="recording-list"><div className="attendance-history-title"><div><span className="eyebrow">SHARED LIBRARY</span><h2>Class recordings</h2></div><button className="button button-outline" onClick={refreshRecordings}><History size={16}/> Refresh</button></div>
      {recordings.length ? <div className="recording-grid">{recordings.map(item => <article className="recording-card" key={item.id}><div className="recording-thumb"><Film size={34}/><span>WEBM VIDEO</span></div><div className="recording-card-body"><h3>{item.title || `Meeting ${item.room}`}</h3><p>Room {item.room} · {new Date(item.createdAt).toLocaleString()}{item.hostName ? ` · by ${item.hostName}` : ''}{!item.shared ? ' · only in this browser' : ''}{item.expiresAt ? ` · deleted automatically on ${new Date(item.expiresAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}</p><p>{Math.floor((item.durationSeconds || 0) / 60)}m {(item.durationSeconds || 0) % 60}s · {((item.sizeBytes || item.blob?.size || 0) / (1024 * 1024)).toFixed(1)} MB</p><div className="recording-actions"><button className="button button-primary" onClick={() => openRecording(item)}><Play size={15}/> Play</button><a className="button button-outline" href={item.url ? item.url : URL.createObjectURL(item.blob)} download={`CloudMeet-${item.room}-${item.createdAt}.webm`}><Download size={15}/> Download</a>{item.shared && item.hostId === currentUser?.id && <button className={`button button-outline ${viewersFor === item.id ? 'viewers-open' : ''}`} onClick={() => toggleViewers(item)}><Users size={15}/> Viewers ({item.viewCount || 0})</button>}{(!item.shared || item.hostId === currentUser?.id) && <button className="icon-button delete-recording" onClick={() => removeRecording(item.id)} title="Delete recording"><Trash2 size={17}/></button>}</div>{viewersFor === item.id && <div className="viewers-list">
        <b>Who watched this recording</b>
        {viewersError ? <p className="viewers-error">{viewersError}</p>
          : !viewersList ? <p>Loading…</p>
          : viewersList.length === 0 ? <p>Nobody has watched it yet.</p>
          : <ul>{viewersList.map(v => <li key={v.name + v.watchedAt}><span>{v.name}</span><span>{new Date(v.watchedAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</span></li>)}</ul>}
      </div>}</div></article>)}</div> : <div className="attendance-empty"><Film size={32}/><h3>No recordings yet</h3><p>Join a meeting, click Record, then stop recording or leave the meeting. Your video will appear here.</p><button className="button button-primary" onClick={() => setScreen('home')}>Go to meetings <ArrowRight size={16}/></button></div>}
      </section>
      <p className="attendance-disclaimer">Recordings are private. They can be watched by the host, by people the host let into the meeting, and by people the host approves here. Knowing a meeting code is not enough. Only the host can delete a recording, and every recording is deleted automatically after a set number of days. The video files are kept in a private Google Cloud Storage bucket.</p>
    </main>
  </div>

  if (screen === 'profile') return <div className="home-app">
    <header className="site-header">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setScreen('home') }}><span className="brand-icon"><Video size={20}/></span><span>Cloud<span className="brand-blue">Meet</span></span></a>
      <nav><a href="#profile-details">Profile</a><a href="#profile-password">Password</a></nav>
      <button className="button button-outline" onClick={() => setScreen('home')}><ArrowRight size={16}/> Back to meetings</button>
    </header>
    <main className="attendance-page profile-page">
      <div className="attendance-heading"><span className="eyebrow">YOUR ACCOUNT</span><h1>Profile settings</h1><p>Update the name others see in meetings, or change your password.</p></div>
      {profileMessage && <div className="profile-success" role="status"><Check size={16}/> {profileMessage}</div>}
      {profileError && <div className="auth-error page-error" role="alert">{profileError}</div>}
      <div className="profile-grid">
        <form className="attendance-history profile-card" id="profile-details" onSubmit={saveProfileName}>
          <div className="profile-card-title"><span className="attendance-stat-icon"><UserRound size={20}/></span><h2>Profile</h2></div>
          <label className="auth-label">Email address<input value={currentUser?.email || ''} disabled /></label>
          <label className="auth-label">Full name<input value={profileName} onChange={e => setProfileName(e.target.value)} minLength={2} maxLength={80} required /></label>
          <button className="button button-primary" type="submit" disabled={profileBusy}>{profileBusy ? 'Saving…' : 'Save name'}</button>
        </form>
        <form className="attendance-history profile-card" id="profile-password" onSubmit={savePassword}>
          <div className="profile-card-title"><span className="attendance-stat-icon violet"><KeyRound size={20}/></span><h2>Change password</h2></div>
          <label className="auth-label">Current password<input type="password" autoComplete="current-password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} required /></label>
          <label className="auth-label">New password<input type="password" autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} minLength={8} placeholder="At least 8 characters" required /></label>
          <label className="auth-label">Confirm new password<input type="password" autoComplete="new-password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} minLength={8} required /></label>
          <button className="button button-primary" type="submit" disabled={profileBusy}>{profileBusy ? 'Saving…' : 'Change password'}</button>
        </form>
      </div>
    </main>
  </div>

  return <div className="home-app">
    <header className="site-header">
      <a className="brand" href="#home" onClick={e => e.preventDefault()} aria-label="CloudMeet home">
        <span className="brand-icon"><Video size={20}/></span>
        <span>Cloud<span className="brand-blue">Meet</span></span>
      </a>

      <nav className="main-navigation" aria-label="Main navigation">
        <a href="#features">Features</a>
        <a href="#about">About</a>
      </nav>

      <div className="header-actions">
        <span className="signed-in-label">Hi, {currentUser?.name || name || 'User'}</span>
        <button className="button button-outline" onClick={() => { loadAttendance(); setScreen('attendance') }}>
          <CalendarCheck size={16}/> <span>Attendance</span>
        </button>
        <button className="button button-outline" onClick={() => { refreshRecordings(); setScreen('recordings') }}>
          <Film size={16}/> <span>Recordings</span>
        </button>
        <button className="button button-outline" onClick={openProfile}>
          <UserRound size={16}/> <span>Profile</span>
        </button>
        <button className="button button-outline sign-out-button" onClick={() => signOut()}>Sign out</button>
        <button className="button button-primary launch-button" onClick={() => { setScreen('start'); document.getElementById('start-panel')?.scrollIntoView({behavior:'smooth'}) }}>
          Launch app <ArrowRight size={16}/>
        </button>
      </div>
    </header>
    <main>
      <section className="hero">
        <div className="hero-copy">
          <div className="announcement"><span><Sparkles size={14}/></span> SIMPLE. CONNECTED. PRODUCTIVE.</div>
          <h1>Good conversations<br/>make <span>great things</span><br/>happen.</h1>
          <p className="hero-description">A simple space for your team to meet, share ideas, and move forward — wherever you are.</p>
          <div className="hero-actions"><button className="button button-primary" onClick={() => { setScreen('start'); document.getElementById('start-panel')?.scrollIntoView({behavior:'smooth'}) }}><Video size={17}/> Start a meeting</button><button className="button button-light" onClick={() => { setScreen('start'); document.getElementById('start-panel')?.scrollIntoView({behavior:'smooth'}) }}><Link2 size={17}/> Join with a code</button></div>
          <div className="hero-trust"><div className="avatar-stack"><span>S</span><span>Y</span><span>T</span><span>+</span></div><p><b>Made for teamwork</b><br/>Meet simply, work better.</p></div>
        </div>
        <div className="hero-visual">
          <div className="visual-glow"></div>
          <div className="mock-window">
            <div className="mock-top"><div className="window-dots"><i/><i/><i/></div><span>CloudMeet · Team room</span><span className="mock-live"><i/> LIVE</span></div>
            <div className="mock-videos"><div className="mock-person person-one"><span className="mock-face">S</span><label>Sam · Product</label></div><div className="mock-person person-two"><span className="mock-face">Y</span><label>Yogita · Design</label></div><div className="mock-person person-three"><span className="mock-face">A</span><label>Alex · Engineering</label></div><div className="mock-person person-four"><span className="mock-face">M</span><label>Mia · Marketing</label></div></div>
            <div className="mock-controls"><span><Mic size={15}/></span><span><Video size={15}/></span><span><MonitorUp size={15}/></span><span className="mock-end"><PhoneOff size={15}/></span><span><MessageCircle size={15}/></span></div>
          </div>
          <div className="float-card float-secure"><span className="float-icon"><ShieldCheck size={18}/></span><div><b>Private by design</b><small>Your space, your team</small></div></div>
          <div className="float-card float-cloud"><span className="float-icon"><Cloud size={18}/></span><div><b>Meet from anywhere</b><small>One link to connect</small></div></div>
        </div>
      </section>

      <section className="start-section" id="start-panel">
        <div className="section-heading"><span className="eyebrow">GET STARTED</span><h2>Your next meeting starts here.</h2><p>Create a new room or join your team's existing meeting.</p></div>
        <div className="start-grid">
          <div className="start-card create-card"><div className="card-icon blue"><Plus size={22}/></div><h3>Create a meeting</h3><p>Start a new room and invite people with a meeting code.</p><label>Meeting title (optional)</label><input value={newMeetingTitle} onChange={e => setNewMeetingTitle(e.target.value)} placeholder="e.g. Cloud Lab review" maxLength={80}/><label>Who can join?</label><select className="access-select" value={newAccessType} onChange={e => setNewAccessType(e.target.value)}><option value="ask">Anyone with the code, after I approve them</option><option value="invite">Invite only (only the emails I list)</option></select>{newAccessType === 'invite' && <><label>Invited email addresses</label><textarea className="access-emails" value={newInvitedEmails} onChange={e => setNewInvitedEmails(e.target.value)} placeholder="one@example.com, two@example.com" rows={3}/></>}<label>Your display name</label><input value={name} onChange={e => setName(e.target.value)} placeholder="Enter your name" maxLength={32}/><button className="button button-primary full" disabled={meetingBusy} onClick={() => startMeeting('', true)}><Video size={17}/> {meetingBusy ? 'Please wait…' : 'Create meeting'} <ArrowRight size={16}/></button></div>
          <div className={`start-card join-card ${inviteRoom ? 'invited' : ''}`} id="join-card"><div className="card-icon purple"><Link2 size={21}/></div><h3>Join a meeting</h3><p>{inviteRoom ? <>You were invited to meeting <b>{inviteRoom}</b>. Check your name and click Join.</> : 'Have a code or invite link? Enter the code below to join your team.'}</p><label>Your display name</label><input value={name} onChange={e => setName(e.target.value)} placeholder="Enter your name" maxLength={32}/><label>Meeting code</label><input value={meetingCode} onChange={e => setMeetingCode(cleanMeetingCode(e.target.value))} placeholder="e.g. A1B2C3" maxLength={12}/><button className="button button-dark full" disabled={meetingBusy} onClick={() => startMeeting(meetingCode, false)}><ArrowRight size={17}/> {meetingBusy ? 'Checking…' : 'Join meeting'}</button>{inviteRoom && <button type="button" className="missed-link" onClick={() => openMissedRecording(inviteRoom)}><Film size={14}/> Missed this meeting? Watch its recording</button>}</div>
        </div>
        {notice && <div className="home-notice">{notice}<button onClick={() => setNotice('')}><X size={15}/></button></div>}
        <div className="status-note"><span className="status-dot"/>{status}</div>
      </section>

      <section className="attendance-promo"><div className="promo-icon"><CalendarCheck size={24}/></div><div><span className="eyebrow">NEW IN CLOUDMEET</span><h2>Keep track of your meetings.</h2><p>Review your past sessions, meeting duration, and personal attendance history.</p></div><button className="button button-primary" onClick={() => { loadAttendance(); setScreen('attendance') }}>View attendance <ArrowRight size={16}/></button></section>
      <section className="attendance-promo recording-promo"><div className="promo-icon"><Film size={24}/></div><div><span className="eyebrow">MEETING LIBRARY</span><h2>Save and replay meetings.</h2><p>Record a session, then play or download the saved video from your browser.</p></div><button className="button button-primary" onClick={() => { refreshRecordings(); setScreen('recordings') }}>View recordings <ArrowRight size={16}/></button></section>
      <section className="features-section" id="features"><div className="section-heading"><span className="eyebrow">BUILT FOR CONNECTION</span><h2>Everything you need to get together.</h2><p>Simple tools that help conversations flow.</p></div><div className="feature-grid"><article className="feature-card"><div className="feature-icon"><Video size={21}/></div><h3>Video that brings you closer</h3><p>Connect face-to-face with browser-based audio and video calling.</p></article><article className="feature-card"><div className="feature-icon violet"><MessageCircle size={21}/></div><h3>Chat as you collaborate</h3><p>Send messages to everyone in the meeting room.</p></article><article className="feature-card"><div className="feature-icon teal"><ShieldCheck size={21}/></div><h3>Your room, your team</h3><p>Join using a room code and keep conversations organized.</p></article></div></section>
      <section className="about-section" id="about"><div className="about-mark"><Video size={25}/></div><div><span className="eyebrow">ABOUT CLOUDMEET</span><h2>Connect. Collaborate. Anywhere.</h2><p>CloudMeet is a college project prototype exploring real-time communication and cloud deployment technologies.</p></div></section>
    </main>
    <footer className="site-footer"><a className="brand" href="#" onClick={e => e.preventDefault()}><span className="brand-icon"><Video size={18}/></span><span>Cloud<span className="brand-blue">Meet</span></span></a><span>Built for better conversations.</span><span>© 2026 CloudMeet · Student project</span></footer>
  </div>
}
