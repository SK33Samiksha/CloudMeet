// MySQL (Google Cloud SQL) connection pool for CloudMeet.
// Written by Yogita Kauthankar; small fixes noted below.
import dotenv from 'dotenv'
import mysql from 'mysql2/promise'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Load environment settings from backend/.env
dotenv.config({
  path: path.join(__dirname, '.env'),
  quiet: true
})

// MySQL is enabled only when DB_HOST is configured.
export const dbConfigured = Boolean(process.env.DB_HOST?.trim())

let pool = null

if (dbConfigured) {
  const requiredSettings = [
    'DB_USER',
    'DB_PASSWORD',
    'DB_NAME'
  ]

  for (const setting of requiredSettings) {
    if (!process.env[setting]) {
      throw new Error(`Missing required database setting: ${setting}`)
    }
  }

  // Encrypted connection to Cloud SQL.
  // FIX: Cloud SQL's server certificate names the instance, not the IP
  // address, so a normal host-name check fails when connecting by IP.
  // We still verify that the certificate is signed by the instance's CA
  // ("verify-ca"), but skip the host-name match.
  // FIX: the certificate file is optional; DB_SSL=true gives an encrypted
  // connection without it.
  const caPath = process.env.DB_SSL_CA
    ? path.resolve(__dirname, process.env.DB_SSL_CA)
    : path.join(__dirname, 'certs', 'server-ca.pem')

  let ssl
  if (existsSync(caPath)) {
    ssl = {
      ca: readFileSync(caPath, 'utf8'),
      rejectUnauthorized: true,
      checkServerIdentity: () => undefined
    }
  } else if (String(process.env.DB_SSL).toLowerCase() === 'true') {
    ssl = { rejectUnauthorized: false }
  }

  pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,

    ssl,

    // FIX: store and read all dates as UTC so times do not shift
    // between the VM and the database.
    timezone: 'Z',

    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    connectTimeout: 10000,
    charset: 'utf8mb4'
  })
}

export { pool }

// Test the database connection when MySQL is configured.
export async function testDatabaseConnection() {
  if (!pool) {
    return {
      connected: false,
      mode: 'json'
    }
  }

  const connection = await pool.getConnection()

  try {
    await connection.query('SELECT 1')
    return {
      connected: true,
      mode: 'mysql'
    }
  } finally {
    connection.release()
  }
}
