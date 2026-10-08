import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { AccessToken } from 'livekit-server-sdk'

const app = express()
app.use(cors())
const http = createServer(app)
const io = new Server(http, { cors: { origin: '*' } })

const YT_KEY = process.env.YT_KEY
const REGION = process.env.REGION ?? 'US'
const LK_URL = process.env.LK_URL ?? 'ws://localhost:7880'
const LK_KEY = process.env.LK_KEY ?? 'watchparty'
const LK_SECRET = process.env.LK_SECRET ?? 'my_super_secret_dev_key_that_is_long_enough_12345'

/* ---------- YouTube browser (quota-friendly) ---------- */

const cache = new Map()
const cached = async (key, ttl, fetcher) => {
  const hit = cache.get(key)
  if (hit && Date.now() < hit.expiry) return hit.data   // 0 quota units
  const data = await fetcher()
  cache.set(key, { data, expiry: Date.now() + ttl })
  return data
}

const fmtDur = (iso = '') => {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!m) return ''
  const [, h, mi, s] = m
  return h ? `${+h}:${String(+mi || 0).padStart(2, '0')}:${String(+s || 0).padStart(2, '0')}`
           : `${+mi || 0}:${String(+s || 0).padStart(2, '0')}`
}

const shape = (item, dur) => ({
  id: item.id.videoId ?? item.id,
  title: item.snippet.title,
  channel: item.snippet.channelTitle,
  thumb: item.snippet.thumbnails.medium?.url ?? item.snippet.thumbnails.default?.url,
  duration: fmtDur(dur),
})

const withDurations = async (items) => {
  const ids = items.map(i => i.id.videoId ?? i.id).join(',')
  const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids}&key=${YT_KEY}`)
  const j = await r.json()
  const dur = Object.fromEntries((j.items ?? []).map(i => [i.id, i.contentDetails.duration]))
  return items.map(i => shape(i, dur[i.id.videoId ?? i.id]))
}

const unesc = (s = '') => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")

app.get('/api/trending', async (_req, res) => {
  try {
    res.json(await cached('trending', 30 * 60 * 1000, async () => {
      const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&maxResults=12&regionCode=${REGION}&key=${YT_KEY}`)
      return withDurations((await r.json()).items ?? [])
    }))
  } catch { res.status(500).json({ error: 'youtube api failed' }) }
})

app.get('/api/search', async (req, res) => {
  const q = (req.query.q ?? '').trim()
  if (!q) return res.json([])
  try {
    res.json(await cached('s:' + q.toLowerCase(), 10 * 60 * 1000, async () => {
      const r = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=12&q=${encodeURIComponent(q)}&key=${YT_KEY}`)
      return withDurations((await r.json()).items ?? [])
    }))
  } catch { res.status(500).json({ error: 'youtube api failed' }) }
})

/* ---------- voice tokens (LiveKit) ---------- */

app.get('/api/voice-token', async (req, res) => {
  const { room, id, name: uname, emoji: uemoji } = req.query
  if (!room || !id) return res.status(400).json({ error: 'missing room or id' })
  try {
    const at = new AccessToken(LK_KEY, LK_SECRET, {
      identity: id,                 // socket.id → unique, maps speakers to chips
      name: `${uemoji} ${uname}`,
      ttl: 3600,
    })
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true })
    res.json({ token: await at.toJwt(), url: LK_URL })
  } catch {
    res.status(500).json({ error: 'voice token failed' })
  }
})

/* ---------- rooms · sync · chat ---------- */

const rooms = new Map()    // code -> Map<socketId, user>
const states = new Map()   // code -> { video, status, position, updatedAt }
const chatLog = new Map()  // code -> last 50 messages
const lastCtrl = new Map() // socketId -> last control timestamp (anti-spam)

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const makeCode = () =>
  Array.from({ length: 6 }, () => CHARS[Math.random() * CHARS.length | 0]).join('')

const pushMsg = (code, msg) => {
  const log = chatLog.get(code) ?? []
  log.push({ id: Math.random().toString(36).slice(2), ts: Date.now(), ...msg })
  if (log.length > 50) log.shift()
  chatLog.set(code, log)
  io.to(code).emit('chat-msg', log[log.length - 1])
}
const sysMsg = (code, text) => pushMsg(code, { sys: true, text })

io.on('connection', (socket) => {
  let room = null
  let me = null

  const enter = (code, name, emoji) => {
    room = code
    me = { id: socket.id, name, emoji }
    socket.join(code)
    rooms.get(code).set(socket.id, me)
    io.to(code).emit('room-update', [...rooms.get(code).values()])
    socket.emit('chat-history', chatLog.get(code) ?? [])
    socket.emit('state-sync', states.get(code) ?? { video: null, status: 'idle', position: 0, updatedAt: Date.now() })
    sysMsg(code, `${emoji} ${name} joined the room`)
  }

  socket.on('create-room', ({ name, emoji }, cb) => {
    const code = makeCode()
    rooms.set(code, new Map())
    enter(code, name, emoji)
    cb({ ok: true, code })
  })

  socket.on('join-room', ({ code, name, emoji }, cb) => {
    code = code.toUpperCase().trim()
    if (!rooms.has(code)) return cb({ ok: false, error: 'Room not found' })
    enter(code, name, emoji)
    cb({ ok: true, code })
  })

  /* ---- sync ---- */

  socket.on('clock-sync', (cb) => cb(Date.now()))

  socket.on('pick-video', (video) => {
    if (!room) return
    states.set(room, { video, status: 'playing', position: 0, updatedAt: Date.now() })
    io.to(room).emit('state-update', states.get(room))
    sysMsg(room, `${me.emoji} ${me.name} queued 🎬 ${unesc(video.title)}`)
  })

  socket.on('control', ({ action, position = 0 }) => {
    if (!room || !states.has(room)) return
    const now = Date.now()
    if (now - (lastCtrl.get(socket.id) ?? 0) < 300) return   // no tug-of-war
    lastCtrl.set(socket.id, now)
    const st = states.get(room)
    if (action === 'play')  { st.status = 'playing'; st.position = position }
    if (action === 'pause') { st.status = 'paused';  st.position = position }
    if (action === 'seek')  { st.position = position }
    st.updatedAt = now
    io.to(room).emit('state-update', st)
  })

  /* ---- chat ---- */

  socket.on('chat', (text) => {
    if (!room || !me) return
    text = String(text).trim().slice(0, 200)
    if (!text) return
    pushMsg(room, { sid: socket.id, name: me.name, emoji: me.emoji, text })
  })

  socket.on('typing', () => {
    if (room && me) socket.to(room).emit('typing', me)   // everyone except sender
  })

  socket.on('disconnect', () => {
    lastCtrl.delete(socket.id)
    if (!room || !rooms.has(room)) return
    rooms.get(room).delete(socket.id)
    if (rooms.get(room).size === 0) {
      rooms.delete(room)
      states.delete(room)
      chatLog.delete(room)
    } else {
      io.to(room).emit('room-update', [...rooms.get(room).values()])
      sysMsg(room, `${me.emoji} ${me.name} left`)
    }
  })
})

http.listen(4000, () => console.log('⚡ Room server + sync + chat + voice tokens on :4000'))