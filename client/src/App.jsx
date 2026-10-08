import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { Room, RoomEvent, Track } from 'livekit-client'

const EMOJIS = ['🦊','🐼','🐸','🦄','👾','🤖','🐯','🐙','🦖','👻','🐺','🦉','🐳','🔥','⚡','🌵','🍕','🎮','🎧','🚀','💀','🌈','🍩','🐝']
const SERVER = 'http://localhost:4000'

const fmtTime = (t = 0) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`
const fmtClock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export default function App() {
  const [screen, setScreen] = useState('landing')
  const [name, setName] = useState(localStorage.getItem('wp-name') ?? '')
  const [emoji, setEmoji] = useState(localStorage.getItem('wp-emoji') ?? '🦊')
  const [joinCode, setJoinCode] = useState('')
  const [code, setCode] = useState('')
  const [users, setUsers] = useState([])
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [videos, setVideos] = useState([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)
  const [needsTap, setNeedsTap] = useState(false)
  const [tab, setTab] = useState('browse')
  const [msgs, setMsgs] = useState([])
  const [chatText, setChatText] = useState('')
  const [unread, setUnread] = useState(0)
  const [typingUser, setTypingUser] = useState(null)
  const [voice, setVoice] = useState('off')   // off | connecting | connected | error
  const [muted, setMuted] = useState(false)
  const [speaking, setSpeaking] = useState(() => new Set())

  const sock = useRef(null)
  const player = useRef(null)
  const playerReady = useRef(false)
  const loadedId = useRef(null)
  const lastState = useRef(null)
  const offset = useRef(0)
  const dragging = useRef(false)
  const tabRef = useRef('browse')
  const msgsBox = useRef(null)
  const typingTimer = useRef(null)
  const lastTyping = useRef(0)
  const voiceRoom = useRef(null)
  const voiceHost = useRef(null)

  /* ---------- sync engine ---------- */

  const serverNow = () => Date.now() + offset.current

  const applyState = (st) => {
    lastState.current = st
    if (st?.video) setPicked(p => p?.id === st.video.id ? p : st.video)
    const p = player.current
    if (!p || !playerReady.current || !st?.video) return
    setNeedsTap(false)

    if (loadedId.current !== st.video.id) {
      loadedId.current = st.video.id
      p.loadVideoById(st.video.id)
    }

    const expected = st.status === 'playing'
      ? st.position + (serverNow() - st.updatedAt) / 1000
      : st.position
    const drift = p.getCurrentTime() - expected

    if (Math.abs(drift) > 1.5) p.seekTo(expected, true)

    if (st.status === 'playing') {
      if (p.getPlayerState() !== 1) p.playVideo()
      p.setPlaybackRate(drift > 0.5 ? 0.75 : drift < -0.5 ? 1.25 : 1)
      setPlaying(true)
    } else {
      if ([1, 3].includes(p.getPlayerState())) p.pauseVideo()
      p.setPlaybackRate(1)
      setPlaying(false)
    }
  }

  /* ---------- socket listeners ---------- */

  useEffect(() => {
    sock.current = io(SERVER)
    sock.current.on('room-update', setUsers)
    sock.current.on('state-sync', applyState)
    sock.current.on('state-update', applyState)
    sock.current.on('chat-history', setMsgs)
    sock.current.on('chat-msg', (m) => {
      setMsgs((prev) => [...prev.slice(-49), m])
      if (tabRef.current !== 'chat') setUnread((u) => u + 1)
    })
    sock.current.on('typing', (u) => {
      setTypingUser(u)
      clearTimeout(typingTimer.current)
      typingTimer.current = setTimeout(() => setTypingUser(null), 2500)
    })
    return () => sock.current.disconnect()
  }, [])

  /* ---------- voice: auto-connect on room entry ---------- */

  useEffect(() => {
    if (screen !== 'room') return
    let dead = false
    ;(async () => {
      setVoice('connecting')
      try {
        const r = await fetch(
          `${SERVER}/api/voice-token?room=${code}&id=${sock.current.id}` +
          `&name=${encodeURIComponent(name)}&emoji=${encodeURIComponent(emoji)}`)
        const { token, url } = await r.json()
        const vr = new Room()
        vr.on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind === Track.Kind.Audio && voiceHost.current) track.attach(voiceHost.current)
        })
        vr.on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()))
        vr.on(RoomEvent.ActiveSpeakersChanged, (spk) =>
          setSpeaking(new Set(spk.map((s) => s.identity))))
        await vr.connect(url, token)
        await vr.localParticipant.setMicrophoneEnabled(true)
        if (dead) return vr.disconnect()
        voiceRoom.current = vr
        setVoice('connected')
      } catch {
        if (!dead) setVoice('error')   // voice is optional — app keeps working
      }
    })()
    return () => {
      dead = true
      voiceRoom.current?.disconnect()
      voiceRoom.current = null
      if (voiceHost.current) voiceHost.current.innerHTML = ''
      setVoice('off'); setMuted(false); setSpeaking(new Set())
    }
  }, [screen, code])

  const toggleMute = async () => {
    if (!voiceRoom.current) return
    const next = !muted
    await voiceRoom.current.localParticipant.setMicrophoneEnabled(!next)
    setMuted(next)
  }

  /* ---------- YouTube player ---------- */

  useEffect(() => {
    if (!window.YT) {
      const tag = document.createElement('script')
      tag.src = 'https://www.youtube.com/iframe_api'
      document.head.appendChild(tag)
    }
  }, [])

  useEffect(() => {
    if (screen !== 'room') return
    const make = () => {
      player.current = new window.YT.Player('yt-player', {
        width: '100%', height: '100%',
        playerVars: { enablejsapi: 1, origin: window.location.origin, controls: 0, rel: 0, playsinline: 1, autoplay: 1 },
        events: {
          onReady: () => {
            playerReady.current = true
            if (lastState.current) applyState(lastState.current)
          },
          onStateChange: (e) => {
            if (e.data === window.YT.PlayerState.UNSTARTED || e.data === window.YT.PlayerState.CUED) {
              if (lastState.current?.status === 'playing') setNeedsTap(true)
            }
          }
        },
      })
    }
    window.YT?.Player ? make() : (window.onYouTubeIframeAPIReady = make)
    return () => { player.current?.destroy?.(); player.current = null; playerReady.current = false; loadedId.current = null }
  }, [screen])

  /* ---------- clock + drift heartbeat ---------- */

  useEffect(() => {
    if (screen !== 'room') return
    const syncClock = () => {
      const t0 = Date.now()
      sock.current.emit('clock-sync', (tServer) => {
        offset.current = tServer + (Date.now() - t0) / 2 - Date.now()
      })
    }
    syncClock()
    const clock = setInterval(syncClock, 30000)
    const fix = setInterval(() => {
      const p = player.current
      if (!p || !playerReady.current || dragging.current) return
      const st = lastState.current
      if (st?.video) {
        setCur(p.getCurrentTime() || 0)
        setDur(p.getDuration() || 0)
        applyState(st)
        if (st.status === 'playing' && [-1, 5].includes(p.getPlayerState())) setNeedsTap(true)
      }
    }, 3000)
    return () => { clearInterval(clock); clearInterval(fix) }
  }, [screen])

  /* ---------- browser ---------- */

  useEffect(() => {
    if (screen !== 'room') return
    setLoading(true)
    const url = query.trim()
      ? `${SERVER}/api/search?q=${encodeURIComponent(query.trim())}`
      : `${SERVER}/api/trending`
    const t = setTimeout(() => {
      fetch(url)
        .then(r => r.json())
        .then(v => { setVideos(v); setLoading(false) })
        .catch(() => setLoading(false))
    }, query.trim() ? 500 : 0)
    return () => clearTimeout(t)
  }, [query, screen])

  /* ---------- chat auto-scroll ---------- */

  useEffect(() => {
    if (tab === 'chat' && msgsBox.current)
      msgsBox.current.scrollTop = msgsBox.current.scrollHeight
  }, [msgs, tab, typingUser])

  /* ---------- actions ---------- */

  const go = (action) => {
    localStorage.setItem('wp-name', name)
    localStorage.setItem('wp-emoji', emoji)
    setError('')
    sock.current.emit(action, { name, emoji, code: joinCode }, (res) => {
      if (!res.ok) return setError(res.error)
      setCode(res.code)
      setScreen('room')
    })
  }

  const pick = (v) => {
    setPicked(v)
    sock.current.emit('pick-video', v)
  }

  const togglePlay = () => {
    const st = lastState.current
    if (!st?.video) return
    const nowPlaying = st.status === 'playing'
    nowPlaying ? player.current?.pauseVideo() : player.current?.playVideo()
    sock.current.emit('control', { action: nowPlaying ? 'pause' : 'play', position: player.current?.getCurrentTime() ?? 0 })
  }

  const switchTab = (t) => {
    tabRef.current = t
    setTab(t)
    if (t === 'chat') setUnread(0)
  }

  const sendMsg = () => {
    const t = chatText.trim()
    if (!t) return
    sock.current.emit('chat', t)
    setChatText('')
  }

  const onChatType = (e) => {
    setChatText(e.target.value)
    if (Date.now() - lastTyping.current > 1500) {
      lastTyping.current = Date.now()
      sock.current.emit('typing')
    }
  }

  const copy = () => {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  const leave = () => {
    sock.current.disconnect()
    sock.current.connect()
    lastState.current = null
    tabRef.current = 'browse'
    setUsers([]); setQuery(''); setPicked(null)
    setPlaying(false); setNeedsTap(false); setCur(0); setDur(0)
    setTab('browse'); setMsgs([]); setChatText(''); setUnread(0); setTypingUser(null)
    setScreen('lobby')
  }

  /* ---------- screens ---------- */

  if (screen === 'landing') return (
    <div className="app">
      <div className="card">
        <h1 className="logo">🍿 WATCH<span>PARTY</span></h1>
        <p className="tagline">sync videos & voice with your squad</p>
        <label>Your name</label>
        <input value={name} maxLength={16} placeholder="e.g. ShadowNinja"
               onChange={(e) => setName(e.target.value)} />
        <label>Pick your avatar</label>
        <div className="emojis">
          {EMOJIS.map((e) => (
            <button key={e} className={e === emoji ? 'on' : ''} onClick={() => setEmoji(e)}>{e}</button>
          ))}
        </div>
        <button className="btn" disabled={!name.trim()} onClick={() => setScreen('lobby')}>LET'S GO →</button>
      </div>
    </div>
  )

  if (screen === 'lobby') return (
    <div className="app">
      <div className="card">
        <h1 className="logo">🍿 WATCH<span>PARTY</span></h1>
        <p className="tagline">hey {name} {emoji} — start or join a room</p>
        <button className="btn" onClick={() => go('create-room')}>+ CREATE ROOM</button>
        <div className="divider">OR JOIN WITH A CODE</div>
        <input value={joinCode} placeholder="XK7Q2M"
               onChange={(e) => setJoinCode(e.target.value.toUpperCase().slice(0, 6))}
               style={{ letterSpacing: '.3em', fontFamily: 'Bungee', textAlign: 'center' }} />
        {error && <p className="error">✖ {error}</p>}
        <button className="btn sky" disabled={joinCode.length !== 6} onClick={() => go('join-room')}>JOIN ROOM →</button>
      </div>
    </div>
  )

  const mine = (m) => m.sid && m.sid === sock.current?.id

  return (
    <div className="app">
      <div className="card room-card">
        <div className="room-layout">

          {/* ---- stage ---- */}
          <div className="stage">
            <div className="player-wrap">
              <div id="yt-player" />
              {!picked && (
                <div className="idle-stage">
                  <p>pick a video from the right —<br />it starts for <b>everyone in the room</b></p>
                </div>
              )}
              {needsTap && (
                <button className="tap-sync" onClick={() => applyState(lastState.current)}>▶ TAP TO SYNC</button>
              )}
              {playing && <span className="sync-live">● LIVE SYNC</span>}

              <div className={`voice-hud ${voice}`}>
                <span className="v-dot" />
                <span className="v-label">
                  {voice === 'connected' ? (muted ? 'MUTED' : 'VOICE ON')
                   : voice === 'connecting' ? 'CONNECTING…'
                   : 'VOICE OFFLINE'}
                </span>
                <button className="mic-btn" onClick={toggleMute} disabled={voice !== 'connected'}
                        title={muted ? 'unmute' : 'mute'}>
                  {muted ? '🔇' : '🎙️'}
                </button>
              </div>
            </div>

            <div className="controls">
              <button className="ctrl-play" onClick={togglePlay} disabled={!picked}>
                {playing ? '⏸' : '▶'}
              </button>
              <span className="time">{fmtTime(cur)}</span>
              <input type="range" className="seek" min={0} max={dur || 0} step={0.1}
                     disabled={!picked} value={Math.min(cur, dur || 0)}
                     onChange={(e) => {
                       dragging.current = true
                       setCur(+e.target.value)
                       player.current?.seekTo(+e.target.value, true)
                     }}
                     onPointerUp={(e) => {
                       dragging.current = false
                       sock.current.emit('control', { action: 'seek', position: +e.target.value })
                     }} />
              <span className="time">{fmtTime(dur)}</span>
            </div>

            {picked && <p className="now-title" dangerouslySetInnerHTML={{ __html: picked.title }} />}
          </div>

          {/* ---- side ---- */}
          <aside className="side">
            <div className="code-box">
              <strong>{code}</strong>
              <button className="copy" onClick={copy}>{copied ? '✓ copied!' : '📋 copy'}</button>
            </div>
            <div className="users">
              {users.map((u) => (
                <span key={u.id} className={`chip${speaking.has(u.id) ? ' talking' : ''}`}>
                  {u.emoji} {u.name}
                  {speaking.has(u.id) && <span className="talk-eq"><i /><i /><i /></span>}
                </span>
              ))}
            </div>

            <div className="tabs">
              <button className={tab === 'browse' ? 'on' : ''} onClick={() => switchTab('browse')}>🔎 BROWSE</button>
              <button className={tab === 'chat' ? 'on' : ''} onClick={() => switchTab('chat')}>
                💬 CHAT {unread > 0 && <span className="badge">{unread > 9 ? '9+' : unread}</span>}
              </button>
            </div>

            {tab === 'browse' ? (
              <>
                <input className="search" value={query} placeholder="🔎 search YouTube…"
                       onChange={(e) => setQuery(e.target.value)} />
                <p className="b-label">{query.trim() ? 'RESULTS' : '🔥 TRENDING'}</p>
                <div className="grid">
                  {loading
                    ? Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="skel">
                          <div className="sk-thumb" /><div className="sk-line" /><div className="sk-line short" />
                        </div>))
                    : videos.map((v) => (
                        <button key={v.id} onClick={() => pick(v)}
                                className={`vcard${picked?.id === v.id ? ' picked' : ''}`}>
                          <div className="thumb">
                            <img src={v.thumb} alt="" loading="lazy" />
                            {v.duration && <span className="dur">{v.duration}</span>}
                            <span className="play-ov">▶</span>
                          </div>
                          <p className="vtitle" dangerouslySetInnerHTML={{ __html: v.title }} />
                          <p className="vchan">{v.channel}</p>
                        </button>))}
                </div>
              </>
            ) : (
              <div className="chat">
                <div className="msgs" ref={msgsBox}>
                  {msgs.map((m) => m.sys
                    ? <p key={m.id} className="sys">— {m.text} —</p>
                    : (
                      <div key={m.id} className={`msg${mine(m) ? ' me' : ''}`}>
                        <p className="meta">{m.emoji} {m.name} · {fmtClock(m.ts)}</p>
                        <p className="bubble">{m.text}</p>
                      </div>
                    ))}
                  {typingUser && (
                    <p className="typing">{typingUser.emoji} {typingUser.name} is typing
                      <span className="dots"><i /><i /><i /></span>
                    </p>
                  )}
                </div>
                <form className="chat-form" onSubmit={(e) => { e.preventDefault(); sendMsg() }}>
                  <input value={chatText} maxLength={200} placeholder="message the room…"
                         onChange={onChatType} />
                  <button type="submit" disabled={!chatText.trim()}>➤</button>
                </form>
              </div>
            )}
          </aside>
        </div>

        <center><button className="leave" onClick={leave}>leave room</button></center>
        <div className="voice-host" ref={voiceHost} />
      </div>
    </div>
  )
}