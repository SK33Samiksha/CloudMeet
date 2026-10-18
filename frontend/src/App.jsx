import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import {
  Video, VideoOff, Mic, MicOff, MonitorUp, MessageCircle, Users,
  Copy, Plus, ArrowRight, PhoneOff, ShieldCheck, Cloud, X, Send,
  Link2, Check, Sparkles, CalendarCheck, History, Clock, BarChart3, Circle, Square, Film, Play, Download, Trash2
} from 'lucide-react'

const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || 'http://localhost:5000'
const API_URL = import.meta.env.VITE_API_URL || SIGNALING_URL
const iceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }

function makeCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase()
}

function VideoTile({ stream, name, muted = false, isLocal = false, cameraOff = false }) {
  const ref = useRef(null)
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream || null
  }, [stream])
  return <div className={`video-tile ${isLocal ? 'local-tile' : ''}`}>
    {stream && !cameraOff
      ? <video ref={ref} autoPlay playsInline muted={muted} />
      : <div className="avatar">{(name || '?').trim().charAt(0).toUpperCase()}</div>}
    <div className="tile-label"><span className="live-dot" />{name}{isLocal ? ' (You)' : ''}</div>
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
  const [attendance, setAttendance] = useState(() => { try { return JSON.parse(localStorage.getItem('cloudmeet-attendance') || '[]') } catch { return [] } })
  const meetingStartedAtRef = useRef(null)
  const [meetingCode, setMeetingCode] = useState('')
  const [name, setName] = useState(() => localStorage.getItem('cloudmeet-name') || '')
  const [room, setRoom] = useState('')
  const [joined, setJoined] = useState(false)
  const [isHost, setIsHost] = useState(false)
  const [micOn, setMicOn] = useState(true)
  const [cameraOn, setCameraOn] = useState(true)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [messages, setMessages] = useState([])
  const [participants, setParticipants] = useState([])
  const [status, setStatus] = useState('Connecting to meeting server…')
  const [copied, setCopied] = useState(false)
  const [notice, setNotice] = useState('')
  const socketRef = useRef(null)
  const streamRef = useRef(null)
  const peersRef = useRef({})
  const remoteStreamsRef = useRef({})
  const [remoteStreams, setRemoteStreams] = useState({})
  const [screenStream, setScreenStream] = useState(null)
  const screenSendersRef = useRef([])
  const localVideoRef = useRef(null)

  // The local video element is mounted only after the meeting screen renders.
  // Attach the stream after React has created that element.
  useEffect(() => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = screenStream || streamRef.current || null
      localVideoRef.current.play?.().catch(() => {})
    }
  }, [screenStream, screen, cameraOn, joined])

  useEffect(() => {
    refreshRecordings()
    const socket = io(SIGNALING_URL, { autoConnect: true, reconnection: true })
    socketRef.current = socket
    socket.on('connect', () => setStatus('Connected to meeting server'))
    socket.on('disconnect', () => setStatus('Disconnected — reconnecting…'))
    socket.on('chat-message', msg => setMessages(prev => [...prev, msg]))
    socket.on('room-users', async users => {
      setParticipants(users)
      for (const user of users) await createPeer(user.id, true)
    })
    socket.on('user-joined', async user => {
      setParticipants(prev => prev.some(p => p.id === user.id) ? prev : [...prev, user])
      setNotice(`${user.name} joined the meeting`)
      setTimeout(() => setNotice(''), 3000)
      await createPeer(user.id, false)
    })
    socket.on('user-left', id => {
      peersRef.current[id]?.close()
      delete peersRef.current[id]
      delete remoteStreamsRef.current[id]
      setRemoteStreams({ ...remoteStreamsRef.current })
      setParticipants(prev => prev.filter(p => p.id !== id))
    })
    socket.on('signal', async ({ from, data }) => {
      let pc = peersRef.current[from]
      if (!pc) pc = await createPeer(from, false)
      try {
        if (data.description) {
          await pc.setRemoteDescription(data.description)
          if (data.description.type === 'offer') {
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            socket.emit('signal', { to: from, data: { description: pc.localDescription } })
          }
        } else if (data.candidate) {
          await pc.addIceCandidate(data.candidate)
        }
      } catch (err) { console.error('Signalling error:', err) }
    })
    return () => {
      Object.values(peersRef.current).forEach(pc => pc.close())
      socket.disconnect()
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

  async function createPeer(peerId, initiator) {
    if (peersRef.current[peerId]) return peersRef.current[peerId]
    const pc = new RTCPeerConnection(iceConfig)
    peersRef.current[peerId] = pc
    if (streamRef.current) streamRef.current.getTracks().forEach(track => { if (!pc.getSenders().some(sender => sender.track?.id === track.id)) pc.addTrack(track, streamRef.current) })
    pc.onicecandidate = e => {
      if (e.candidate) socketRef.current?.emit('signal', { to: peerId, data: { candidate: e.candidate } })
    }
    pc.ontrack = e => {
      const stream = e.streams[0]
      remoteStreamsRef.current[peerId] = stream
      setRemoteStreams({ ...remoteStreamsRef.current })
    }
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected'].includes(pc.connectionState)) {
        setNotice('A connection issue occurred. Some networks require a TURN relay.')
        setTimeout(() => setNotice(''), 4500)
      }
    }
    if (initiator) {
      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        socketRef.current?.emit('signal', { to: peerId, data: { description: pc.localDescription } })
      } catch (err) { console.error(err) }
    }
    return pc
  }

  async function refreshRecordings() {
    let shared = []
    const token = localStorage.getItem('cloudmeet-token')
    if (token) {
      try {
        const response = await fetch(`${API_URL}/api/recordings`, { headers: { Authorization: `Bearer ${token}` } })
        if (response.ok) {
          const data = await response.json()
          shared = (data.recordings || []).map(item => ({ ...item, shared: true, url: `${API_URL}${item.url}?token=${encodeURIComponent(token)}` }))
        }
      } catch (err) { console.warn('Could not load shared recordings', err) }
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

  function signOut() {
    localStorage.removeItem('cloudmeet-token')
    localStorage.removeItem('cloudmeet-user')
    setCurrentUser(null)
    setAuthMode('login')
    setAuthPassword('')
    setScreen('auth')
  }

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
      setRecordingBusy(true)
      const canvas = document.createElement('canvas')
      canvas.width = 1280; canvas.height = 720
      const ctx = canvas.getContext('2d')
      recordingCanvasRef.current = canvas
      const draw = () => {
        ctx.fillStyle = '#101827'; ctx.fillRect(0, 0, canvas.width, canvas.height)
        const videos = [...document.querySelectorAll('.video-grid video')].filter(v => v.readyState >= 2 && v.videoWidth)
        if (!videos.length) {
          ctx.fillStyle = '#ffffff'; ctx.font = 'bold 36px sans-serif'; ctx.fillText('CloudMeet meeting', 48, 80)
          ctx.font = '24px sans-serif'; ctx.fillText(`Room ${room} · ${new Date().toLocaleString()}`, 48, 125)
        } else {
          const cols = videos.length === 1 ? 1 : 2
          const rows = Math.ceil(videos.length / cols)
          const gap = 16, pad = 24
          const tileW = (canvas.width - pad * 2 - gap * (cols - 1)) / cols
          const tileH = (canvas.height - pad * 2 - gap * (rows - 1)) / rows
          videos.forEach((video, i) => {
            const x = pad + (i % cols) * (tileW + gap), y = pad + Math.floor(i / cols) * (tileH + gap)
            const scale = Math.max(tileW / video.videoWidth, tileH / video.videoHeight)
            const sw = tileW / scale, sh = tileH / scale
            ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, tileW, tileH, 18); ctx.clip()
            ctx.drawImage(video, (video.videoWidth - sw) / 2, (video.videoHeight - sh) / 2, sw, sh, x, y, tileW, tileH)
            ctx.restore()
          })
        }
        recordingAnimationRef.current = requestAnimationFrame(draw)
      }
      draw()
      const output = canvas.captureStream(24)
      const audioContext = new AudioContext()
      recordingAudioContextRef.current = audioContext
      const destination = audioContext.createMediaStreamDestination()
      const audioStreams = [streamRef.current, ...Object.values(remoteStreamsRef.current)]
      audioStreams.forEach(stream => {
        if (stream?.getAudioTracks().length) {
          const audioOnly = new MediaStream(stream.getAudioTracks())
          audioContext.createMediaStreamSource(audioOnly).connect(destination)
        }
      })
      destination.stream.getAudioTracks().forEach(track => output.addTrack(track))
      const options = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? { mimeType: 'video/webm;codecs=vp9,opus' } : { mimeType: 'video/webm' }
      const recorder = new MediaRecorder(output, options)
      recordingChunksRef.current = []
      recorder.ondataavailable = event => { if (event.data?.size) recordingChunksRef.current.push(event.data) }
      recorder.onstop = async () => {
        try {
          const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || 'video/webm' })
          if (blob.size) {
            const item = { id: `${Date.now()}-${room}`, title: `Meeting ${room}`, room, createdAt: Date.now(), durationSeconds: Math.max(1, Math.round((Date.now() - (recorder.startedAt || Date.now())) / 1000)), blob }
            await saveRecording(item)
            const token = localStorage.getItem('cloudmeet-token')
            if (token) {
              try {
                const response = await fetch(`${API_URL}/api/recordings`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'video/webm', 'X-Recording-Room': room, 'X-Recording-Title': `Meeting ${room}`, 'X-Recording-Duration': String(item.durationSeconds) }, body: blob })
                const data = await response.json().catch(() => ({}))
                if (!response.ok) throw new Error(data.error || 'Upload failed')
                await refreshRecordings()
                setNotice('Recording uploaded to the shared library. Signed-in users can watch it later.')
              } catch (uploadError) {
                console.error('Shared recording upload failed:', uploadError)
                await refreshRecordings()
                setNotice('Saved only in this browser because shared upload failed. Check the backend terminal.')
              }
            } else { await refreshRecordings(); setNotice('Recording saved locally. Sign in to upload it for other users.') }
          }
        } catch (err) {
          console.error(err)
          setNotice('The recording could not be saved. Browser storage may be full.')
        } finally {
          cancelAnimationFrame(recordingAnimationRef.current)
          recordingAudioContextRef.current?.close().catch(() => {})
          recordingAudioContextRef.current = null
          setRecordingActive(false); setRecordingBusy(false)
          setTimeout(() => setNotice(''), 5000)
        }
      }
      recorder.startedAt = Date.now()
      recorder.start(1000)
      recorderRef.current = recorder
      setRecordingActive(true)
      setNotice('Recording started. Participants in the meeting can be captured; tell everyone before recording.')
      setTimeout(() => setNotice(''), 4000)
    } catch (err) {
      console.error('Recording error:', err)
      setNotice('Could not start recording. Check browser permissions and try again.')
      setRecordingBusy(false)
      setTimeout(() => setNotice(''), 5000)
    }
  }

  function stopRecording() {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop()
  }

  async function openRecording(item) {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl)
    setRecordingUrl(item.url ? item.url : URL.createObjectURL(item.blob))
  }

  async function removeRecording(id) {
    if (!window.confirm('Delete this recording?')) return
    try {
      const item = recordings.find(record => record.id === id)
      if (item?.shared) {
        const response = await fetch(`${API_URL}/api/recordings/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${localStorage.getItem('cloudmeet-token')}` } })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || 'Delete failed')
      } else await deleteRecording(id)
      if (recordingUrl) { URL.revokeObjectURL(recordingUrl); setRecordingUrl('') }
      await refreshRecordings()
    } catch { setNotice('Could not delete this recording.') }
  }

  async function startMeeting(code, host = false) {
    setIsHost(host)
    const cleanName = name.trim() || 'Guest'
    setName(cleanName)
    localStorage.setItem('cloudmeet-name', cleanName)
    const finalCode = (code || makeCode()).trim().toUpperCase()
    setRoom(finalCode)
    meetingStartedAtRef.current = Date.now()
    setMeetingCode(finalCode)
    setMessages([])
    setNotice('')
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access needs localhost or HTTPS.')
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
      setMicOn(stream.getAudioTracks().some(track => track.enabled)); setCameraOn(stream.getVideoTracks().some(track => track.enabled))
    } catch (err) {
      console.error('Media startup failed:', err?.name, err?.message, err)
      setMicOn(false); setCameraOn(false)
      setNotice(`Camera/microphone could not start (${err?.name || 'device error'}). Check browser site permissions and Windows privacy settings.`)
      setTimeout(() => setNotice(''), 8000)
    }
    socketRef.current.emit('join-room', { room: finalCode, name: cleanName })
    setJoined(true)
    setScreen('meeting')
  }

  function toggleMic() {
    const next = !micOn
    streamRef.current?.getAudioTracks().forEach(t => { t.enabled = next })
    setMicOn(next)
  }
  function toggleCamera() {
    const next = !cameraOn
    streamRef.current?.getVideoTracks().forEach(t => { t.enabled = next })
    setCameraOn(next)
  }
  async function shareScreen() {
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) { setNotice('Screen sharing requires a supported browser on localhost or HTTPS.'); setTimeout(() => setNotice(''), 4500); return }
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      const screenTrack = display.getVideoTracks()[0]
      if (!screenTrack) return
      const senders = []
      for (const [peerId, pc] of Object.entries(peersRef.current)) {
        let sender = pc.getSenders().find(item => item.track?.kind === 'video')
        if (sender) { await sender.replaceTrack(screenTrack); senders.push(sender) }
        else {
          sender = pc.addTrack(screenTrack, display); senders.push(sender)
          const offer = await pc.createOffer(); await pc.setLocalDescription(offer)
          socketRef.current?.emit('signal', { to: peerId, data: { description: pc.localDescription } })
        }
      }
      screenSendersRef.current = senders; setScreenStream(display)
      screenTrack.onended = async () => {
        const cameraTrack = streamRef.current?.getVideoTracks()[0] || null
        await Promise.all(screenSendersRef.current.map(async sender => { try { await sender.replaceTrack(cameraTrack) } catch (error) { console.warn('Could not restore camera track:', error) } }))
        screenSendersRef.current = []; setScreenStream(null); display.getTracks().forEach(track => track.stop())
      }
      setNotice(senders.length ? 'Screen sharing is active for connected participants.' : 'Screen sharing started. A participant must be connected to receive it.')
      setTimeout(() => setNotice(''), 4500)
    } catch (err) {
      console.error('Screen share error:', err?.name, err?.message, err)
      if (!['AbortError', 'NotAllowedError'].includes(err?.name)) { setNotice(`Could not start screen sharing (${err?.name || 'unknown error'}).`); setTimeout(() => setNotice(''), 5000) }
    }
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
      setCopied(true); setTimeout(() => setCopied(false), 1600)
    } catch { setNotice(`Meeting code: ${room}`); setTimeout(() => setNotice(''), 4000) }
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
    socketRef.current?.emit('leave-room', { room })
    if (meetingStartedAtRef.current) {
      const endedAt = Date.now()
      const record = { id: `${endedAt}-${room}`, name: name || 'Guest', room, joinedAt: meetingStartedAtRef.current, leftAt: endedAt, durationMinutes: Math.max(1, Math.round((endedAt - meetingStartedAtRef.current) / 60000)) }
      setAttendance(prev => { const next = [record, ...prev].slice(0, 100); localStorage.setItem('cloudmeet-attendance', JSON.stringify(next)); return next })
      meetingStartedAtRef.current = null
    }
    Object.values(peersRef.current).forEach(pc => pc.close())
    peersRef.current = {}; remoteStreamsRef.current = {}; setRemoteStreams({})
    streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null
    screenStream?.getTracks().forEach(t => t.stop()); setScreenStream(null); screenSendersRef.current = []
    setParticipants([]); setJoined(false); setChatOpen(false); setScreen('home')
  }

  if (screen === 'auth') return <div className="auth-page">
    <div className="auth-side">
      <a className="brand auth-brand" href="#" onClick={e => e.preventDefault()}><span className="brand-icon"><Video size={20}/></span><span>Cloud<span className="brand-blue">Meet</span></span></a>
      <div className="auth-pitch"><span className="announcement"><Sparkles size={14}/> SIMPLE. CONNECTED. PRODUCTIVE.</span><h1>Bring everyone<br/>into <span>one room.</span></h1><p>Meet, share ideas, and stay connected with your team from anywhere.</p><div className="auth-benefit"><ShieldCheck size={18}/><span><b>Your own account</b><small>Your meeting profile is saved for next time.</small></span></div><div className="auth-benefit"><Users size={18}/><span><b>Made for teamwork</b><small>Join a meeting with a simple room code.</small></span></div></div>
      <div className="auth-side-foot">CloudMeet · Student project prototype</div>
    </div>
    <div className="auth-main"><form className="auth-card" onSubmit={submitAuth}>
      <span className="eyebrow">WELCOME TO CLOUDMEET</span><h2>{authMode === 'signup' ? 'Create your account' : 'Welcome back'}</h2><p className="auth-subtitle">{authMode === 'signup' ? 'Sign up to start joining and hosting meetings.' : 'Sign in to continue to your meetings.'}</p>
      {authError && <div className="auth-error" role="alert">{authError}</div>}
      {authMode === 'signup' && <label className="auth-label">Full name<input autoComplete="name" value={authName} onChange={e => setAuthName(e.target.value)} placeholder="Enter your name" minLength={2} maxLength={80} required /></label>}
      <label className="auth-label">Email address<input type="email" autoComplete="email" value={authEmail} onChange={e => setAuthEmail(e.target.value)} placeholder="you@example.com" required /></label>
      <label className="auth-label">Password<input type="password" autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'} value={authPassword} onChange={e => setAuthPassword(e.target.value)} placeholder={authMode === 'signup' ? 'At least 8 characters' : 'Enter your password'} minLength={authMode === 'signup' ? 8 : undefined} required /></label>
      <button className="button button-primary full auth-submit" type="submit" disabled={authBusy}>{authBusy ? 'Please wait…' : authMode === 'signup' ? 'Create account' : 'Sign in'} <ArrowRight size={16}/></button>
      <p className="auth-switch">{authMode === 'signup' ? 'Already have an account?' : "Don't have an account?"} <button type="button" onClick={() => { setAuthMode(authMode === 'signup' ? 'login' : 'signup'); setAuthError('') }}>{authMode === 'signup' ? 'Sign in' : 'Sign up'}</button></p>
      <p className="auth-footnote">Your account is saved in the CloudMeet backend database on this machine. This local database is not yet Google Cloud SQL.</p>
    </form></div>
  </div>

  if (screen === 'meeting') {
    return <div className="meeting-app">
      <header className="meeting-header">
        <a className="brand compact" href="#" onClick={e => { e.preventDefault(); leaveMeeting() }}><span className="brand-icon"><Video size={19}/></span><span>Cloud<span className="brand-blue">Meet</span></span></a>
        <div className="room-info"><span className="live-dot" /> Meeting <b>{room}</b><button className="icon-button small" onClick={copyCode} title="Copy meeting code">{copied ? <Check size={15}/> : <Copy size={15}/>}</button></div>
        <div className="header-right"><span className="connection-status">{status}</span><span className="people-count"><Users size={16}/>{participants.length + 1}</span></div>
      </header>
      {notice && <div className="toast">{notice}</div>}
      <main className={`meeting-main ${chatOpen ? 'with-chat' : ''}`}>
        <section className="video-stage">
          <div className="stage-topline"><div><span className="eyebrow">LIVE SESSION</span><h1>Team meeting</h1></div><div className="stage-badges"><span className="secure-badge"><ShieldCheck size={14}/> Private room code</span><span className="secure-badge"><Users size={14}/>{participants.length + 1} participant{participants.length ? 's' : ''}</span></div></div>
          <div className="video-grid">
            <div className="video-tile local-tile">
              {screenStream || (cameraOn && streamRef.current) ? <video ref={localVideoRef} autoPlay playsInline muted /> : <div className="avatar">{(name || 'G').charAt(0).toUpperCase()}</div>}
              <div className="tile-label"><span className="live-dot"/>{name || 'Guest'} (You)</div>
              {!micOn && <span className="muted-indicator"><MicOff size={14}/></span>}
            </div>
            {Object.entries(remoteStreams).map(([id, stream]) => {
              const person = participants.find(p => p.id === id)
              return <VideoTile key={id} stream={stream} name={person?.name || 'Participant'} />
            })}
            {Object.keys(remoteStreams).length === 0 && <div className="empty-tile"><div className="empty-icon"><Users size={27}/></div><h3>Waiting for others to join</h3><p>Share the meeting code so your team can join.</p><button className="button button-light" onClick={copyCode}><Copy size={15}/>{copied ? 'Copied!' : 'Copy meeting code'}</button></div>}
          </div>
          <div className="control-dock">
            <div className="control-group">
              <button className={`control ${!micOn ? 'off' : ''}`} onClick={toggleMic}><span>{micOn ? <Mic/> : <MicOff/>}</span><small>{micOn ? 'Mute' : 'Unmute'}</small></button>
              <button className={`control ${!cameraOn ? 'off' : ''}`} onClick={toggleCamera}><span>{cameraOn ? <Video/> : <VideoOff/>}</span><small>{cameraOn ? 'Stop video' : 'Start video'}</small></button>
              <button className="control" onClick={shareScreen}><span><MonitorUp/></span><small>Share screen</small></button>
              {isHost && <button className={`control ${recordingActive ? 'recording-control' : ''}`} onClick={recordingActive ? stopRecording : startRecording} disabled={recordingBusy}><span>{recordingActive ? <Square/> : <Circle/>}</span><small>{recordingBusy ? 'Starting…' : recordingActive ? 'Stop recording' : 'Record'}</small></button>}
              <button className={`control ${chatOpen ? 'selected' : ''}`} onClick={() => setChatOpen(!chatOpen)}><span><MessageCircle/></span><small>Chat</small>{messages.length > 0 && <i className="message-badge">{messages.length}</i>}</button>
            </div>
            <button className="leave-button" onClick={leaveMeeting}><PhoneOff size={18}/><span>Leave</span></button>
          </div>
        </section>
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
        <article className="attendance-stat"><span className="attendance-stat-icon"><CalendarCheck size={20}/></span><p>Meetings attended</p><strong>{uniqueMeetings}</strong><small>Sessions recorded on this browser</small></article>
        <article className="attendance-stat"><span className="attendance-stat-icon violet"><Clock size={20}/></span><p>Total time in meetings</p><strong>{totalMinutes} <em>min</em></strong><small>Based on join and leave time</small></article>
        <article className="attendance-stat"><span className="attendance-stat-icon teal"><BarChart3 size={20}/></span><p>Average session</p><strong>{uniqueMeetings ? Math.round(totalMinutes / uniqueMeetings) : 0} <em>min</em></strong><small>Across your recorded sessions</small></article>
      </div>
      <section className="attendance-history" id="attendance-history"><div className="attendance-history-title"><div><span className="eyebrow">RECENT ACTIVITY</span><h2>Meeting history</h2></div><button className="button button-outline" onClick={() => { setAttendance([]); localStorage.removeItem('cloudmeet-attendance') }} disabled={!attendance.length}>Clear history</button></div>
        {attendance.length ? <div className="attendance-table-wrap"><table className="attendance-table"><thead><tr><th>Participant</th><th>Meeting code</th><th>Date</th><th>Joined</th><th>Duration</th><th>Status</th></tr></thead><tbody>{attendance.map(item => <tr key={item.id}><td><b>{item.name}</b></td><td><span className="meeting-code-pill">{item.room}</span></td><td>{new Date(item.joinedAt).toLocaleDateString()}</td><td>{new Date(item.joinedAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</td><td>{item.durationMinutes} min</td><td><span className="attendance-present">Recorded</span></td></tr>)}</tbody></table></div> : <div className="attendance-empty"><History size={30}/><h3>No attendance records yet</h3><p>Join or create a meeting, then leave it to see your session here.</p><button className="button button-primary" onClick={() => { setScreen('home'); setTimeout(() => document.getElementById('start-panel')?.scrollIntoView({behavior:'smooth'}), 0) }}>Start a meeting <ArrowRight size={16}/></button></div>}
      </section>
      <p className="attendance-disclaimer">Prototype note: records are saved in this browser only. This version tracks your own meeting sessions; organization-wide attendance reports and administrator access require a shared database and user accounts.</p>
    </main>
  </div>

  if (screen === 'recordings') return <div className="home-app">
    <header className="site-header">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setScreen('home') }}><span className="brand-icon"><Video size={20}/></span><span>Cloud<span className="brand-blue">Meet</span></span></a>
      <nav><a href="#recording-list">Saved videos</a></nav>
      <button className="button button-outline" onClick={() => setScreen('home')}><ArrowRight size={16}/> Back to meetings</button>
    </header>
    <main className="attendance-page recordings-page">
      <div className="attendance-heading"><span className="eyebrow">MEETING LIBRARY</span><h1>Recordings</h1><p>Play shared class recordings, including sessions you missed.</p></div>
      {recordingUrl && <section className="recording-player"><div className="attendance-history-title"><h2>Preview recording</h2><button className="button button-outline" onClick={() => { URL.revokeObjectURL(recordingUrl); setRecordingUrl('') }}>Close player</button></div><video controls autoPlay src={recordingUrl}/></section>}
      <section className="attendance-history" id="recording-list"><div className="attendance-history-title"><div><span className="eyebrow">SHARED LIBRARY</span><h2>Class recordings</h2></div><button className="button button-outline" onClick={refreshRecordings}><History size={16}/> Refresh</button></div>
      {recordings.length ? <div className="recording-grid">{recordings.map(item => <article className="recording-card" key={item.id}><div className="recording-thumb"><Film size={34}/><span>WEBM VIDEO</span></div><div className="recording-card-body"><h3>{item.title || `Meeting ${item.room}`}</h3><p>Room {item.room} · {new Date(item.createdAt).toLocaleString()}</p><p>{Math.floor((item.durationSeconds || 0) / 60)}m {(item.durationSeconds || 0) % 60}s · {((item.sizeBytes || item.blob?.size || 0) / (1024 * 1024)).toFixed(1)} MB</p><div className="recording-actions"><button className="button button-primary" onClick={() => openRecording(item)}><Play size={15}/> Play</button><a className="button button-outline" href={item.url ? item.url : URL.createObjectURL(item.blob)} download={`CloudMeet-${item.room}-${item.createdAt}.webm`}><Download size={15}/> Download</a><button className="icon-button delete-recording" onClick={() => removeRecording(item.id)} title="Delete recording"><Trash2 size={17}/></button></div></div></article>)}</div> : <div className="attendance-empty"><Film size={32}/><h3>No recordings yet</h3><p>Join a meeting, click Record, then stop recording or leave the meeting. Your video will appear here.</p><button className="button button-primary" onClick={() => setScreen('home')}>Go to meetings <ArrowRight size={16}/></button></div>}
      </section>
      <p className="attendance-disclaimer">Shared recordings are stored on the CloudMeet backend server so signed-in users can watch them from another browser. For deployment across computers, use durable cloud object storage such as Google Cloud Storage. Make sure participants know when recording is active.</p>
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
        <button className="button button-outline" onClick={() => setScreen('attendance')}>
          <CalendarCheck size={16}/> <span>Attendance</span>
        </button>
        <button className="button button-outline" onClick={() => { refreshRecordings(); setScreen('recordings') }}>
          <Film size={16}/> <span>Recordings</span>
        </button>
        <button className="button button-outline sign-out-button" onClick={signOut}>Sign out</button>
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
          <div className="start-card create-card"><div className="card-icon blue"><Plus size={22}/></div><h3>Create a meeting</h3><p>Start a new room and invite people with a meeting code.</p><label>Your display name</label><input value={name} onChange={e => setName(e.target.value)} placeholder="Enter your name" maxLength={32}/><button className="button button-primary full" onClick={() => startMeeting(makeCode(), true)}><Video size={17}/> Create meeting <ArrowRight size={16}/></button></div>
          <div className="start-card join-card"><div className="card-icon purple"><Link2 size={21}/></div><h3>Join a meeting</h3><p>Have a code? Enter it below to join your team.</p><label>Your display name</label><input value={name} onChange={e => setName(e.target.value)} placeholder="Enter your name" maxLength={32}/><label>Meeting code</label><input value={meetingCode} onChange={e => setMeetingCode(e.target.value.toUpperCase())} placeholder="e.g. A1B2C3" maxLength={12}/><button className="button button-dark full" onClick={() => meetingCode.trim() ? startMeeting(meetingCode, false) : setNotice('Please enter a meeting code first.')}><ArrowRight size={17}/> Join meeting</button></div>
        </div>
        {notice && <div className="home-notice">{notice}<button onClick={() => setNotice('')}><X size={15}/></button></div>}
        <div className="status-note"><span className="status-dot"/>{status}</div>
      </section>

      <section className="attendance-promo"><div className="promo-icon"><CalendarCheck size={24}/></div><div><span className="eyebrow">NEW IN CLOUDMEET</span><h2>Keep track of your meetings.</h2><p>Review your past sessions, meeting duration, and personal attendance history.</p></div><button className="button button-primary" onClick={() => setScreen('attendance')}>View attendance <ArrowRight size={16}/></button></section>
      <section className="attendance-promo recording-promo"><div className="promo-icon"><Film size={24}/></div><div><span className="eyebrow">MEETING LIBRARY</span><h2>Save and replay meetings.</h2><p>Record a session, then play or download the saved video from your browser.</p></div><button className="button button-primary" onClick={() => { refreshRecordings(); setScreen('recordings') }}>View recordings <ArrowRight size={16}/></button></section>
      <section className="features-section" id="features"><div className="section-heading"><span className="eyebrow">BUILT FOR CONNECTION</span><h2>Everything you need to get together.</h2><p>Simple tools that help conversations flow.</p></div><div className="feature-grid"><article className="feature-card"><div className="feature-icon"><Video size={21}/></div><h3>Video that brings you closer</h3><p>Connect face-to-face with browser-based audio and video calling.</p></article><article className="feature-card"><div className="feature-icon violet"><MessageCircle size={21}/></div><h3>Chat as you collaborate</h3><p>Send messages to everyone in the meeting room.</p></article><article className="feature-card"><div className="feature-icon teal"><ShieldCheck size={21}/></div><h3>Your room, your team</h3><p>Join using a room code and keep conversations organized.</p></article></div></section>
      <section className="about-section" id="about"><div className="about-mark"><Video size={25}/></div><div><span className="eyebrow">ABOUT CLOUDMEET</span><h2>Connect. Collaborate. Anywhere.</h2><p>CloudMeet is a college project prototype exploring real-time communication and cloud deployment technologies.</p></div></section>
    </main>
    <footer className="site-footer"><a className="brand" href="#" onClick={e => e.preventDefault()}><span className="brand-icon"><Video size={18}/></span><span>Cloud<span className="brand-blue">Meet</span></span></a><span>Built for better conversations.</span><span>© 2026 CloudMeet · Student project</span></footer>
  </div>
}
