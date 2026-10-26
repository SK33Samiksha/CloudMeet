// CloudMeet data storage.
//
// Two interchangeable back ends with the SAME functions:
//   - MySQL (Google Cloud SQL) when DB_HOST is set in backend/.env
//   - JSON files in backend/data/ when DB_HOST is empty (local development)
//
// server.js only calls the functions exported at the bottom of this file,
// so the API responses and Socket.IO events are identical in both modes.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, 'data')

export class DuplicateError extends Error {}

function newMeetingCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from(randomBytes(6), byte => letters[byte % letters.length]).join('')
}

const toMs = value => (value ? new Date(value).getTime() : null)

// ======================================================================
// JSON FILE STORE (same behaviour as before the MySQL integration)
// ======================================================================
function createJsonStore() {
  mkdirSync(DATA_DIR, { recursive: true })
  const USERS_FILE = path.join(DATA_DIR, 'users.json')
  const MEETINGS_FILE = path.join(DATA_DIR, 'meetings.json')
  const RECORDINGS_FILE = path.join(DATA_DIR, 'recordings.json')
  for (const file of [USERS_FILE, MEETINGS_FILE, RECORDINGS_FILE]) {
    if (!existsSync(file)) writeFileSync(file, '[]')
  }
  const MAX_SAVED_MESSAGES = 300

  const read = file => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      console.error(`Could not read ${file}:`, error.message)
      throw new Error('Data storage is unavailable.')
    }
  }
  const write = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
  const findMeeting = (code, meetings = read(MEETINGS_FILE)) =>
    meetings.find(meeting => meeting.id === code) || null
  const updateMeeting = (code, change) => {
    const meetings = read(MEETINGS_FILE)
    const meeting = findMeeting(code, meetings)
    if (!meeting) return null
    change(meeting)
    write(MEETINGS_FILE, meetings)
    return meeting
  }
  const attended = (meeting, userId) => Boolean(meeting) && (
    meeting.host_user_id === userId ||
    meeting.participants.some(person => person.user_id === userId)
  )
  const publicMeeting = meeting => meeting && {
    id: meeting.id,
    title: meeting.title,
    host_user_id: meeting.host_user_id,
    host_name: meeting.host_name,
    created_at: meeting.created_at,
    status: meeting.status
  }

  return {
    mode: 'json',
    async init() {},

    // ---- users ----
    async findUserByEmail(email) {
      return read(USERS_FILE).find(user => user.email === email) || null
    },
    async findUserById(id) {
      return read(USERS_FILE).find(user => user.id === id) || null
    },
    async createUser({ name, email, password_hash }) {
      const users = read(USERS_FILE)
      if (users.some(user => user.email === email)) throw new DuplicateError()
      const id = users.reduce((max, user) => Math.max(max, Number(user.id) || 0), 0) + 1
      users.push({ id, name, email, password_hash, created_at: new Date().toISOString() })
      write(USERS_FILE, users)
      return { id, name, email }
    },
    async updateUserName(id, name) {
      const users = read(USERS_FILE)
      const user = users.find(item => item.id === id)
      if (!user) return null
      user.name = name
      write(USERS_FILE, users)
      return { id: user.id, name: user.name, email: user.email }
    },
    async updateUserPassword(id, password_hash) {
      const users = read(USERS_FILE)
      const user = users.find(item => item.id === id)
      if (!user) return false
      user.password_hash = password_hash
      write(USERS_FILE, users)
      return true
    },

    // ---- meetings ----
    async createMeeting({ title, host_user_id, host_name }) {
      const meetings = read(MEETINGS_FILE)
      let id
      do { id = newMeetingCode() } while (findMeeting(id, meetings))
      const meeting = {
        id, title, host_user_id, host_name,
        created_at: new Date().toISOString(),
        status: 'scheduled',
        participants: [], viewers: [], messages: []
      }
      meetings.push(meeting)
      write(MEETINGS_FILE, meetings)
      return publicMeeting(meeting)
    },
    async getMeeting(code) {
      return publicMeeting(findMeeting(code))
    },
    async addParticipant(code, entry) {
      updateMeeting(code, meeting => {
        meeting.status = 'live'
        meeting.participants.push({
          id: entry.id,
          user_id: entry.user_id,
          name: entry.name,
          joined_at: entry.joined_at.toISOString(),
          left_at: null
        })
      })
    },
    async closeParticipant(code, attendanceId, roomIsEmpty) {
      updateMeeting(code, meeting => {
        const entry = meeting.participants.find(item => item.id === attendanceId)
        if (entry && !entry.left_at) entry.left_at = new Date().toISOString()
        if (roomIsEmpty) meeting.status = 'ended'
      })
    },
    async getRecentMessages(code, limit) {
      const meeting = findMeeting(code)
      return (meeting?.messages || []).slice(-limit).map(message => ({
        id: message.id,
        name: message.name,
        message_text: message.message_text,
        sent_at: message.sent_at
      }))
    },
    async addMessage(code, message) {
      updateMeeting(code, meeting => {
        meeting.messages.push({ ...message, sent_at: message.sent_at.toISOString() })
        if (meeting.messages.length > MAX_SAVED_MESSAGES) {
          meeting.messages = meeting.messages.slice(-MAX_SAVED_MESSAGES)
        }
      })
    },
    async listAttendance(userId) {
      const records = []
      for (const meeting of read(MEETINGS_FILE)) {
        for (const person of meeting.participants) {
          if (person.user_id !== userId) continue
          records.push({
            id: person.id,
            room: meeting.id,
            title: meeting.title,
            name: person.name,
            isHost: meeting.host_user_id === userId,
            joinedAt: toMs(person.joined_at),
            leftAt: toMs(person.left_at),
            participantCount: new Set(meeting.participants.map(p => p.user_id)).size
          })
        }
      }
      return records.sort((a, b) => b.joinedAt - a.joinedAt)
    },
    async addViewer(code, userId) {
      return publicMeeting(updateMeeting(code, meeting => {
        meeting.viewers = meeting.viewers || []
        if (!attended(meeting, userId) && !meeting.viewers.includes(userId)) {
          meeting.viewers.push(userId)
        }
      }))
    },

    // ---- recordings ----
    async canViewRecording(recording, userId) {
      if (recording.host_id === userId) return true
      const meeting = findMeeting(recording.room)
      if (!meeting) return true // older recordings without a saved meeting
      return attended(meeting, userId) || (meeting.viewers || []).includes(userId)
    },
    async listRecordings() {
      return read(RECORDINGS_FILE).map(recording => ({
        ...recording,
        view_count: (recording.views || []).length
      }))
    },
    async getRecording(id) {
      return read(RECORDINGS_FILE).find(item => item.id === id) || null
    },
    async countRecordingsInRoom(code) {
      return read(RECORDINGS_FILE).filter(item => item.room === code).length
    },
    async createRecording(recording) {
      const recordings = read(RECORDINGS_FILE)
      recordings.unshift(recording)
      write(RECORDINGS_FILE, recordings)
    },
    async recordView(recordingId, userId, name) {
      const recordings = read(RECORDINGS_FILE)
      const recording = recordings.find(item => item.id === recordingId)
      if (!recording) return
      recording.views = (recording.views || []).filter(view => view.user_id !== userId)
      recording.views.push({ user_id: userId, name, watched_at: new Date().toISOString() })
      write(RECORDINGS_FILE, recordings)
    },
    async listViews(recordingId) {
      const recording = read(RECORDINGS_FILE).find(item => item.id === recordingId)
      return (recording?.views || []).map(view => ({ name: view.name, watched_at: view.watched_at }))
    },
    async deleteRecording(id) {
      write(RECORDINGS_FILE, read(RECORDINGS_FILE).filter(item => item.id !== id))
    }
  }
}

// ======================================================================
// MYSQL STORE (Google Cloud SQL)
// Connection: db.js. Tables: backend/db/schema.sql (both by Yogita).
// Every query uses ? placeholders (parameterized), never string building.
// ======================================================================
async function createMysqlStore() {
  // The connection pool comes from db.js (Yogita's Cloud SQL connection).
  const { pool, testDatabaseConnection } = await import('./db.js')
  await testDatabaseConnection()

  const one = async (sql, params) => (await pool.execute(sql, params))[0][0] || null
  const all = async (sql, params) => (await pool.execute(sql, params))[0]
  const run = async (sql, params) => (await pool.execute(sql, params))[0]

  const meetingRow = row => row && {
    id: row.id,
    title: row.title,
    host_user_id: Number(row.host_user_id),
    host_name: row.host_name,
    created_at: row.created_at,
    status: row.status
  }
  const recordingRow = row => row && {
    id: row.id,
    title: row.title,
    room: row.room,
    filename: row.filename,
    size: Number(row.size),
    duration_seconds: Number(row.duration_seconds),
    created_at: row.created_at,
    host_id: Number(row.host_id),
    host_name: row.host_name,
    storage: row.storage,
    gcs_object: row.gcs_object || undefined,
    view_count: row.view_count !== undefined ? Number(row.view_count) : undefined
  }
  const userRow = row => row && {
    id: Number(row.id),
    name: row.name,
    email: row.email,
    password_hash: row.password_hash
  }

  const attended = async (code, userId) => Boolean(await one(
    `SELECT 1 FROM meetings WHERE id = ? AND host_user_id = ?
     UNION SELECT 1 FROM participants WHERE meeting_id = ? AND user_id = ? LIMIT 1`,
    [code, userId, code, userId]
  ))

  return {
    mode: 'mysql',
    async init() {
      // Fail early with a clear message if Cloud SQL is unreachable.
      const row = await one('SELECT COUNT(*) AS tables_found FROM information_schema.tables WHERE table_schema = DATABASE()', [])
      if (Number(row.tables_found) < 7) {
        throw new Error(`Expected 7 CloudMeet tables, found ${row.tables_found}. Run backend/db/schema.sql first.`)
      }
    },

    // ---- users ----
    async findUserByEmail(email) {
      return userRow(await one('SELECT id, name, email, password_hash FROM users WHERE email = ?', [email]))
    },
    async findUserById(id) {
      return userRow(await one('SELECT id, name, email, password_hash FROM users WHERE id = ?', [id]))
    },
    async createUser({ name, email, password_hash }) {
      try {
        const result = await run(
          'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
          [name, email, password_hash]
        )
        return { id: Number(result.insertId), name, email }
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') throw new DuplicateError()
        throw error
      }
    },
    async updateUserName(id, name) {
      const result = await run('UPDATE users SET name = ? WHERE id = ?', [name, id])
      if (!result.affectedRows) return null
      const user = await this.findUserById(id)
      return { id: user.id, name: user.name, email: user.email }
    },
    async updateUserPassword(id, password_hash) {
      const result = await run('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash, id])
      return result.affectedRows > 0
    },

    // ---- meetings ----
    async createMeeting({ title, host_user_id, host_name }) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const id = newMeetingCode()
        try {
          await run(
            `INSERT INTO meetings (id, title, host_user_id, host_name, created_at, status)
             VALUES (?, ?, ?, ?, ?, 'scheduled')`,
            [id, title, host_user_id, host_name, new Date()]
          )
          return this.getMeeting(id)
        } catch (error) {
          if (error.code !== 'ER_DUP_ENTRY') throw error
        }
      }
      throw new Error('Could not generate a unique meeting code.')
    },
    async getMeeting(code) {
      return meetingRow(await one(
        'SELECT id, title, host_user_id, host_name, created_at, status FROM meetings WHERE id = ?',
        [code]
      ))
    },
    async addParticipant(code, entry) {
      await run(
        'INSERT INTO participants (id, meeting_id, user_id, name, joined_at, left_at) VALUES (?, ?, ?, ?, ?, NULL)',
        [entry.id, code, entry.user_id, entry.name, entry.joined_at]
      )
      await run(`UPDATE meetings SET status = 'live' WHERE id = ?`, [code])
    },
    async closeParticipant(code, attendanceId, roomIsEmpty) {
      await run(
        'UPDATE participants SET left_at = ? WHERE id = ? AND meeting_id = ? AND left_at IS NULL',
        [new Date(), attendanceId, code]
      )
      if (roomIsEmpty) await run(`UPDATE meetings SET status = 'ended' WHERE id = ?`, [code])
    },
    async getRecentMessages(code, limit) {
      const rows = await all(
        `SELECT id, name, message_text, sent_at FROM messages
         WHERE meeting_id = ? ORDER BY sent_at DESC LIMIT ${Number(limit) | 0}`,
        [code]
      )
      return rows.reverse()
    },
    async addMessage(code, message) {
      await run(
        'INSERT INTO messages (id, meeting_id, sender_user_id, name, message_text, sent_at) VALUES (?, ?, ?, ?, ?, ?)',
        [message.id, code, message.sender_user_id, message.name, message.message_text, message.sent_at]
      )
    },
    async listAttendance(userId) {
      const rows = await all(
        `SELECT p.id, p.meeting_id, m.title, p.name, m.host_user_id, p.joined_at, p.left_at,
                (SELECT COUNT(DISTINCT p2.user_id) FROM participants p2 WHERE p2.meeting_id = p.meeting_id) AS participant_count
         FROM participants p
         JOIN meetings m ON m.id = p.meeting_id
         WHERE p.user_id = ?
         ORDER BY p.joined_at DESC`,
        [userId]
      )
      return rows.map(row => ({
        id: row.id,
        room: row.meeting_id,
        title: row.title,
        name: row.name,
        isHost: Number(row.host_user_id) === userId,
        joinedAt: toMs(row.joined_at),
        leftAt: toMs(row.left_at),
        participantCount: Number(row.participant_count)
      }))
    },
    async addViewer(code, userId) {
      const meeting = await this.getMeeting(code)
      if (!meeting) return null
      if (!(await attended(code, userId))) {
        await run('INSERT IGNORE INTO meeting_viewers (meeting_id, user_id) VALUES (?, ?)', [code, userId])
      }
      return meeting
    },

    // ---- recordings ----
    async canViewRecording(recording, userId) {
      if (recording.host_id === userId) return true
      if (!(await one('SELECT 1 FROM meetings WHERE id = ?', [recording.room]))) return true
      if (await attended(recording.room, userId)) return true
      return Boolean(await one(
        'SELECT 1 FROM meeting_viewers WHERE meeting_id = ? AND user_id = ?',
        [recording.room, userId]
      ))
    },
    async listRecordings() {
      const rows = await all(
        `SELECT r.*, (SELECT COUNT(DISTINCT v.user_id) FROM recording_views v WHERE v.recording_id = r.id) AS view_count
         FROM recordings r ORDER BY r.created_at DESC`,
        []
      )
      return rows.map(recordingRow)
    },
    async getRecording(id) {
      return recordingRow(await one('SELECT * FROM recordings WHERE id = ?', [id]))
    },
    async countRecordingsInRoom(code) {
      return Number((await one('SELECT COUNT(*) AS n FROM recordings WHERE room = ?', [code])).n)
    },
    async createRecording(r) {
      await run(
        `INSERT INTO recordings
           (id, title, room, filename, size, duration_seconds, created_at, host_id, host_name, storage, gcs_object)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.id, r.title, r.room, r.filename, r.size, r.duration_seconds, new Date(r.created_at),
          r.host_id, r.host_name, r.storage, r.gcs_object || null]
      )
    },
    async recordView(recordingId, userId, name) {
      // Keep one row per person: remove their earlier view, then add the new one.
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        await connection.execute('DELETE FROM recording_views WHERE recording_id = ? AND user_id = ?', [recordingId, userId])
        await connection.execute(
          'INSERT INTO recording_views (recording_id, user_id, name, watched_at) VALUES (?, ?, ?, ?)',
          [recordingId, userId, name, new Date()]
        )
        await connection.commit()
      } catch (error) {
        await connection.rollback()
        throw error
      } finally {
        connection.release()
      }
    },
    async listViews(recordingId) {
      return all('SELECT name, watched_at FROM recording_views WHERE recording_id = ?', [recordingId])
    },
    async deleteRecording(id) {
      await run('DELETE FROM recordings WHERE id = ?', [id]) // views are removed by ON DELETE CASCADE
    },

    async close() { await pool.end() }
  }
}

export async function createStore() {
  if (process.env.DB_HOST && process.env.DB_HOST.trim()) {
    const store = await createMysqlStore()
    await store.init()
    return store
  }
  return createJsonStore()
}
