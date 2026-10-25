// Google Cloud Storage for meeting recordings.
//
// If GCS_BUCKET is set in backend/.env, recording videos are uploaded to
// that bucket and played back from it. If it is NOT set, recordings stay
// on the server's disk exactly as before, so the app keeps working.
//
// On a Compute Engine VM no key file is needed: the library uses the VM's
// service account automatically. The VM needs permission to read and write
// objects in the bucket (see README, "Cloud Storage").
import { Storage } from '@google-cloud/storage'

const BUCKET_NAME = (process.env.GCS_BUCKET || '').trim()

// GCS_API_ENDPOINT is only used for local testing with an emulator.
const storage = BUCKET_NAME
  ? new Storage(process.env.GCS_API_ENDPOINT
      ? { apiEndpoint: process.env.GCS_API_ENDPOINT, projectId: 'local-test' }
      : {})
  : null

const bucket = storage ? storage.bucket(BUCKET_NAME) : null

export const cloudStorageEnabled = Boolean(bucket)
export const cloudStorageBucket = BUCKET_NAME

// Copy a local file into the bucket.
export async function uploadToCloud(localPath, objectName, contentType) {
  await bucket.upload(localPath, {
    destination: objectName,
    resumable: false,
    metadata: { contentType: contentType || 'video/webm' }
  })
}

// Send a video from the bucket to the browser. Supports "Range" requests,
// which the <video> player uses for seeking.
export async function streamFromCloud(objectName, req, res) {
  const file = bucket.file(objectName)
  const [metadata] = await file.getMetadata()
  const size = Number(metadata.size)
  const contentType = metadata.contentType || 'video/webm'

  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', contentType)

  let start = 0
  let end = size - 1
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')

  if (range) {
    if (range[1] === '' && range[2] !== '') {
      // "bytes=-500" means the last 500 bytes
      start = Math.max(0, size - Number(range[2]))
    } else {
      start = Number(range[1] || 0)
      if (range[2] !== '') end = Math.min(Number(range[2]), size - 1)
    }

    if (start > end || start >= size) {
      res.setHeader('Content-Range', `bytes */${size}`)
      return res.status(416).end()
    }

    res.status(206)
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
  }

  res.setHeader('Content-Length', end - start + 1)

  file.createReadStream({ start, end, validation: false })
    .on('error', error => {
      console.error('Cloud Storage read failed:', error.message)
      if (!res.headersSent) res.status(500).json({ error: 'Could not play recording.' })
      else res.destroy(error)
    })
    .pipe(res)
}

export async function deleteFromCloud(objectName) {
  await bucket.file(objectName).delete({ ignoreNotFound: true })
}
