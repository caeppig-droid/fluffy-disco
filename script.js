/* ==========================================================
   Escape the Island — script.js
   Client-side only. Multiplayer via PeerJS (WebRTC).

   Architecture
   - The HOST's browser is the single source of truth (variable `H`).
   - Every change on the host calls broadcast(), which sends a full
     public snapshot ({t:'state', s}) to every peer. Clients never
     modify state themselves; they only send requests
     ({t:'join'|'roll'|'answer'}) and render whatever snapshot arrives.
   - Snapshots carry a rising `rev`, so late/out-of-order packets are
     ignored, and a player who reconnects instantly gets the full truth.
   - The correct answer is never put in a snapshot until the reveal.
   ========================================================== */
(() => {
  'use strict';

  /* ---------------------------------------------------------
     CONFIG
     --------------------------------------------------------- */
  const TEACHER_PIN = '8675309';
  const PEER_PREFIX = 'escape-island-v1-';
  const STORE_Q = 'escapeIsland.questions.v1';
  const STORE_NAME = 'escapeIsland.name';
  const SESS_TOKEN = 'escapeIsland.token';
  const SESS_ROOM = 'escapeIsland.room';

  const TARGET = 10;           // supplies needed to launch the raft
  const MAX_PLAYERS = 8;
  const DICE_MS = 1000;        // die rattle time
  const STEP_MS = 300;         // time per hop of a token
  const LAND_PAUSE_MS = 600;   // breathing room after landing
  const REVEAL_MS = 7000;      // auto-continue delay after answers are revealed
  const PING_MS = 4000;        // heartbeat interval (both directions)
  const STALE_MS = 20000;      // silence longer than this = treated as disconnected
  const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I)

  // Circular board: 24 spaces, clockwise from the top.
  const BOARD = [
    'start', 'wood', 'blank', 'rope', 'food', 'blank',
    'medkit', 'wood', 'blank', 'rope', 'blank', 'food',
    'medkit', 'blank', 'wood', 'rope', 'blank', 'food',
    'blank', 'medkit', 'wood', 'blank', 'rope', 'food'
  ];
  const N = BOARD.length;
  const RING_R = 38;      // % of board width where the spaces sit
  const TOKEN_OFF = 6.6;  // % further out where tokens sit

  const ITEMS = {
    wood:   { emoji: '🪵', label: 'Wood' },
    rope:   { emoji: '🪢', label: 'Rope' },
    food:   { emoji: '🥭', label: 'Mango' },
    medkit: { emoji: '🩹', label: 'Medkit' }
  };

  const COLORS = ['#e4572e', '#2b7fb8', '#7b4fd8', '#d6336c', '#2f8f4e', '#d98200', '#0f8b8d', '#8d5524'];

  const DEFAULT_QUESTIONS = [
    ['What is 7 x 8?', '56 | fifty-six'],
    ['What is 9 + 6?', '15 | fifteen'],
    ['What is 100 - 35?', '65 | sixty-five'],
    ['What is 6 x 7?', '42 | forty-two'],
    ['How many sides does a hexagon have?', '6 | six'],
    ['How many minutes are in one hour?', '60 | sixty'],
    ['How many days are in one week?', '7 | seven'],
    ['Which is bigger: 1/2 or 1/4?', '1/2 | one half | half'],
    ['What planet do we live on?', 'Earth'],
    ['What do plants need from the sun to make food?', 'sunlight | light | sun | light from the sun'],
    ['What force pulls objects toward the Earth?', 'gravity'],
    ['What do we call animals that eat only plants?', 'herbivore | herbivores'],
    ['What is the largest ocean on Earth?', 'Pacific | Pacific Ocean'],
    ['What is the capital city of Colorado?', 'Denver'],
    ['What is the nickname of Colorado: the Centennial State or the Sunshine State?', 'Centennial | Centennial State'],
    ['What is the plural of "mouse"?', 'mice'],
    ['What is the past tense of "run"?', 'ran'],
    ['What is the opposite of "ancient"?', 'modern | new | recent'],
    ['A noun that names a specific person or place is called a ___ noun.', 'proper'],
    ['What is the name for water that falls from clouds as rain, snow, or hail?', 'precipitation'],
    ['What is the word for a story that is made up and not real?', 'fiction'],
    ['How many legs does an insect have?', '6 | six'],
    ['What are the three states of matter we learn about? (name one)', 'solid | liquid | gas']
  ];

  /* ---------------------------------------------------------
     SMALL UTILITIES
     --------------------------------------------------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function uid(len = 8) {
    let s = '';
    while (s.length < len) s += Math.random().toString(36).slice(2);
    return s.slice(0, len);
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const safeStore = (area) => ({
    get(k, d = null) { try { const v = window[area].getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { window[area].setItem(k, v); } catch (e) { /* storage unavailable */ } }
  });
  const local = safeStore('localStorage');
  const session = safeStore('sessionStorage');

  let toastTimer = null;
  function toast(msg, ms = 3200) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  function showScreen(name) {
    ['home', 'lobby', 'game'].forEach(n => $('#screen-' + n).classList.toggle('hidden', n !== name));
  }

  function cleanName(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 14);
  }
  function initial(name) { return (name || '?').trim().charAt(0).toUpperCase() || '?'; }

  /* ---------------------------------------------------------
     QUESTION BANK (localStorage)
     --------------------------------------------------------- */
  let questions = [];

  const validQ = (q) => q && typeof q.q === 'string' && typeof q.a === 'string' && q.q.trim() && q.a.trim();

  function loadQuestions() {
    const raw = local.get(STORE_Q);
    if (raw !== null) {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          questions = arr.filter(validQ).map(q => ({ id: q.id || uid(), q: q.q.trim(), a: q.a.trim() }));
          return;
        }
      } catch (e) { /* fall through to samples */ }
    }
    questions = DEFAULT_QUESTIONS.map(([q, a]) => ({ id: uid(), q, a }));
    saveQuestions();
  }
  function saveQuestions() { local.set(STORE_Q, JSON.stringify(questions)); }

  /* ---------------------------------------------------------
     ANSWER CHECKING
     --------------------------------------------------------- */
  function normalize(s) {
    let t = String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    t = t.replace(/['’]/g, '');
    t = t.replace(/[^a-z0-9\s/.]/g, ' ');     // punctuation and hyphens become spaces
    t = t.replace(/\.(?!\d)/g, ' ');          // keep decimal points only
    t = t.replace(/\s+/g, ' ').trim();
    t = t.replace(/^(the|a|an) /, '');
    return t;
  }

  function editDistance(a, b) {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 2) return 99;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }

  function isCorrect(given, answerField) {
    const g = normalize(given);
    if (!g) return false;
    return String(answerField).split('|').map(normalize).filter(Boolean).some(opt => {
      if (g === opt) return true;
      if (/\d/.test(opt)) return false;                 // numbers must match exactly
      const tol = opt.length >= 10 ? 2 : opt.length >= 5 ? 1 : 0;
      return tol > 0 && editDistance(g, opt) <= tol;    // forgive small typos on longer words
    });
  }

  const displayAnswer = (a) => String(a).split('|').map(s => s.trim()).filter(Boolean).join(' / ');

  /* ---------------------------------------------------------
     NETWORK STATE
     --------------------------------------------------------- */
  const net = {
    role: null,        // 'host' | 'client'
    peer: null,
    code: '',
    conns: {},         // host: peerId -> DataConnection
    hostConn: null,    // client: connection to host
    me: { pid: null, name: '' },
    leaving: false
  };

  function getToken() {
    let t = session.get(SESS_TOKEN);
    if (!t) { t = uid(16); session.set(SESS_TOKEN, t); }
    return t;
  }

  function randomCode() {
    let c = '';
    for (let i = 0; i < 4; i++) c += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
    return c;
  }

  /* ---------------------------------------------------------
     HOST: authoritative state
     --------------------------------------------------------- */
  let H = null;

  function initHostState(hostName) {
    H = {
      rev: 0,
      phase: 'lobby',            // lobby | roll | moving | question | reveal | won | lost
      players: [],               // {pid,name,color,pos,connected}
      turn: 0,
      raft: [],                  // ordered list of collected item types
      roll: { seq: 0, value: 0, pid: null },
      deck: [],                  // remaining questions (with answers) — HOST ONLY
      totalQ: 0,
      asked: 0,
      current: null,             // current question (with answer) — HOST ONLY
      answers: {},               // pid -> typed answer
      landed: null,
      reveal: null,
      log: [],
      autoContinue: true,
      hostName,
      hostPlays: true,
      peerToPid: {},
      lastSeen: {},
      timer: null
    };
    H.players.push({ pid: 'host', name: hostName, color: COLORS[0], pos: 0, connected: true });
  }

  const hostLog = (msg) => { H.log.push(msg); if (H.log.length > 30) H.log.shift(); };
  const currentPlayer = () => H.players[H.turn] || null;

  function nextColor() {
    return COLORS.find(c => !H.players.some(p => p.color === c)) || COLORS[H.players.length % COLORS.length];
  }

  function uniqueName(name) {
    let base = name || 'Castaway';
    let n = base, i = 2;
    while (H.players.some(p => p.name.toLowerCase() === n.toLowerCase())) n = base.slice(0, 12) + ' ' + (i++);
    return n;
  }

  function snapshot() {
    const inQ = (H.phase === 'question' || H.phase === 'reveal') && H.current;
    const cur = currentPlayer();
    return {
      rev: H.rev,
      phase: H.phase,
      code: net.code,
      hostName: H.hostName,
      hostPlays: H.hostPlays,
      autoContinue: H.autoContinue,
      players: H.players.map(p => ({ pid: p.pid, name: p.name, color: p.color, pos: p.pos, connected: p.connected, isHost: p.pid === 'host' })),
      turnPid: cur ? cur.pid : null,
      raft: H.raft.slice(),
      target: TARGET,
      roll: { seq: H.roll.seq, value: H.roll.value, pid: H.roll.pid },
      deckLeft: H.deck.length,
      totalQ: H.totalQ,
      qCount: questions.length,
      question: inQ ? { id: H.current.id, num: H.asked, text: H.current.q } : null,
      answered: Object.keys(H.answers),
      landed: H.landed,
      reveal: H.reveal,
      log: H.log.slice(-6)
    };
  }

  function broadcast() {
    H.rev++;
    const snap = snapshot();
    Object.values(net.conns).forEach(c => {
      if (c && c.open) { try { c.send({ t: 'state', s: snap }); } catch (e) { /* ignore */ } }
    });
    // The host renders the same snapshot locally. Only a non-playing host
    // (the facilitator) gets to peek at the correct answer.
    const extra = {};
    if (H.current && (H.phase === 'question') && !H.players.some(p => p.pid === 'host')) {
      extra.hostAnswer = displayAnswer(H.current.a);
    }
    applyState(snap, extra);
  }

  function advanceTurn() {
    const n = H.players.length;
    if (!n) return;
    for (let i = 1; i <= n; i++) {
      const idx = (H.turn + i) % n;
      if (H.players[idx].connected) { H.turn = idx; return; }
    }
  }

  /* ----- Host: game flow ----- */
  function hostStart() {
    loadQuestions();
    if (!questions.length) { toast('Add at least one question in Teacher Mode first.'); return; }
    if (!H.players.some(p => p.connected)) { toast('Wait for at least one player to join.'); return; }

    clearTimeout(H.timer);
    H.deck = shuffle(questions.map(q => ({ id: uid(), q: q.q, a: q.a })));
    H.totalQ = H.deck.length;
    H.asked = 0;
    H.raft = [];
    H.players.forEach(p => { p.pos = 0; });
    H.turn = Math.max(0, H.players.findIndex(p => p.connected));
    H.roll = { seq: H.roll.seq, value: 0, pid: null };
    H.current = null;
    H.answers = {};
    H.landed = null;
    H.reveal = null;
    H.log = [];
    H.phase = 'roll';
    hostLog('The crew washes ashore. Find supplies and build a raft!');
    broadcast();
  }

  function hostSetHostPlays(v) {
    if (H.phase !== 'lobby') return;
    H.hostPlays = !!v;
    const has = H.players.some(p => p.pid === 'host');
    if (v && !has) H.players.unshift({ pid: 'host', name: H.hostName, color: nextColor(), pos: 0, connected: true });
    if (!v && has) H.players = H.players.filter(p => p.pid !== 'host');
    broadcast();
  }

  function hostRoll(callerPid) {
    if (H.phase !== 'roll') return;
    const p = currentPlayer();
    if (!p) return;
    // The current player may roll; the host may also roll for anyone (e.g. a student who stepped away).
    if (callerPid !== p.pid && callerPid !== 'host') return;

    const value = 1 + Math.floor(Math.random() * 6);
    H.roll = { seq: H.roll.seq + 1, value, pid: p.pid };
    p.pos = (p.pos + value) % N;
    H.landed = null;
    H.phase = 'moving';
    hostLog(`${p.name} rolled a ${value}.`);
    broadcast();

    clearTimeout(H.timer);
    H.timer = setTimeout(hostLand, DICE_MS + value * STEP_MS + LAND_PAUSE_MS);
  }

  function hostLand() {
    if (H.phase !== 'moving') return;
    const p = currentPlayer();
    if (!p) return;
    const type = BOARD[p.pos];

    let gained = false;
    if (ITEMS[type] && H.raft.length < TARGET) { H.raft.push(type); gained = true; }
    H.landed = { pid: p.pid, name: p.name, pos: p.pos, type, gained };
    hostLog(gained ? `${p.name} found ${ITEMS[type].label}! ${ITEMS[type].emoji}` : `${p.name} landed on empty sand.`);

    const q = H.deck.pop();
    if (!q) { // safety net: cannot happen when the game starts with >= 1 question
      H.phase = H.raft.length >= TARGET ? 'won' : 'lost';
      broadcast();
      return;
    }
    H.current = q;
    H.asked++;
    H.answers = {};
    H.reveal = null;
    H.phase = 'question';
    broadcast();
    checkQuestionDone();
  }

  function hostAnswer(pid, msg) {
    if (H.phase !== 'question' || !H.current) return;
    if (!msg || msg.qid !== H.current.id) return;
    if (!H.players.some(p => p.pid === pid)) return;
    if (Object.prototype.hasOwnProperty.call(H.answers, pid)) return;
    const text = String(msg.text == null ? '' : msg.text).replace(/\s+/g, ' ').trim().slice(0, 80);
    H.answers[pid] = text || '(no answer)';
    if (!checkQuestionDone()) broadcast();
  }

  // Everyone who is connected must answer before the question resolves.
  function checkQuestionDone() {
    if (H.phase !== 'question') return false;
    const need = H.players.filter(p => p.connected);
    if (need.every(p => Object.prototype.hasOwnProperty.call(H.answers, p.pid))) {
      resolveQuestion();
      return true;
    }
    return false;
  }

  function resolveQuestion() {
    if (H.phase !== 'question' || !H.current) return;
    const results = H.players.map(p => {
      const has = Object.prototype.hasOwnProperty.call(H.answers, p.pid);
      return { pid: p.pid, text: has ? H.answers[p.pid] : null, correct: has && isCorrect(H.answers[p.pid], H.current.a) };
    });
    const right = results.filter(r => r.correct).length;
    H.reveal = { answer: displayAnswer(H.current.a), results };
    H.phase = 'reveal';
    hostLog(`${right} of ${results.length} answered correctly.`);
    broadcast();

    clearTimeout(H.timer);
    if (H.autoContinue) H.timer = setTimeout(hostContinue, REVEAL_MS);
  }

  function hostContinue() {
    if (H.phase !== 'reveal') return;
    clearTimeout(H.timer);
    if (H.raft.length >= TARGET) {
      H.phase = 'won';
      hostLog('The raft is ready. You escaped!');
    } else if (H.deck.length === 0) {
      H.phase = 'lost';
      hostLog('The questions ran out.');
    } else {
      advanceTurn();
      H.phase = 'roll';
      H.current = null;
      H.landed = null;
      H.reveal = null;
      H.answers = {};
    }
    broadcast();
  }

  /* ----- Host: connections ----- */
  function onHostConnection(conn) {
    net.conns[conn.peer] = conn;
    conn.on('data', (msg) => hostOnMessage(conn, msg));
    conn.on('close', () => hostOnClose(conn));
    conn.on('error', () => hostOnClose(conn));
  }

  function hostOnMessage(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'join') return hostJoin(conn, msg);
    const pid = H.peerToPid[conn.peer];
    if (!pid) return;                       // must join first
    H.lastSeen[pid] = Date.now();
    const who = H.players.find(x => x.pid === pid);
    if (who && !who.connected) {            // heartbeat resumed: they're back
      who.connected = true;
      hostLog(`${who.name} is back.`);
      broadcast();
    }
    if (msg.t === 'ping') return;
    if (msg.t === 'roll') return hostRoll(pid);
    if (msg.t === 'answer') return hostAnswer(pid, msg);
  }

  function hostJoin(conn, msg) {
    const token = String(msg.token || '').slice(0, 40);
    if (!token || token === 'host') return;
    let p = H.players.find(x => x.pid === token);

    if (!p) {
      if (H.players.length >= MAX_PLAYERS) {
        try { conn.send({ t: 'reject', reason: 'This room is full (8 players max).' }); } catch (e) { /* ignore */ }
        setTimeout(() => { try { conn.close(); } catch (e) { /* ignore */ } }, 400);
        return;
      }
      p = { pid: token, name: uniqueName(cleanName(msg.name)), color: nextColor(), pos: 0, connected: true };
      H.players.push(p);
      hostLog(`${p.name} joined the crew.`);
    } else {
      // Same player coming back (refresh or dropped connection): drop their stale connection.
      Object.keys(H.peerToPid).forEach(peerId => {
        if (H.peerToPid[peerId] === token && peerId !== conn.peer) {
          delete H.peerToPid[peerId];
          const old = net.conns[peerId];
          delete net.conns[peerId];
          try { old && old.close(); } catch (e) { /* ignore */ }
        }
      });
      if (!p.connected) hostLog(`${p.name} is back.`);
      p.connected = true;
    }

    H.peerToPid[conn.peer] = token;
    H.lastSeen[token] = Date.now();
    try { conn.send({ t: 'welcome', pid: token }); } catch (e) { /* ignore */ }
    broadcast();
  }

  function hostOnClose(conn) {
    if (net.conns[conn.peer] === conn) delete net.conns[conn.peer];
    const pid = H.peerToPid[conn.peer];
    if (!pid) return;
    delete H.peerToPid[conn.peer];
    if (Object.values(H.peerToPid).includes(pid)) return;   // they already reconnected elsewhere
    hostMarkOffline(pid);
  }

  // Used for real closes AND for heartbeat timeouts (tab closed, laptop lid shut, Wi-Fi dropped).
  function hostMarkOffline(pid) {
    const idx = H.players.findIndex(p => p.pid === pid);
    if (idx < 0 || pid === 'host') return;
    const p = H.players[idx];
    if (!p.connected) return;

    if (H.phase === 'lobby') {
      H.players.splice(idx, 1);
      Object.keys(H.peerToPid).forEach(k => { if (H.peerToPid[k] === pid) delete H.peerToPid[k]; });
      broadcast();
      return;
    }

    p.connected = false;
    hostLog(`${p.name} lost connection.`);
    if (H.phase === 'roll' && currentPlayer() && currentPlayer().pid === pid) advanceTurn();
    if (H.phase === 'question') { if (!checkQuestionDone()) broadcast(); return; }
    broadcast();
  }

  function hostHeartbeat() {
    if (!H) return;
    const now = Date.now();
    Object.values(net.conns).forEach(c => { if (c && c.open) { try { c.send({ t: 'hb' }); } catch (e) { /* ignore */ } } });
    H.players.forEach(p => {
      if (p.pid !== 'host' && p.connected && now - (H.lastSeen[p.pid] || 0) > STALE_MS) hostMarkOffline(p.pid);
    });
  }

  /* ---------------------------------------------------------
     CREATING / JOINING A ROOM
     --------------------------------------------------------- */
  function homeMsg(text, isError = true) {
    const m = $('#homeMsg');
    m.textContent = text || '';
    m.classList.toggle('error', !!text && isError);
  }
  function setBusy(b) { $$('#screen-home button').forEach(x => { x.disabled = b; }); }

  function peerAvailable() {
    if (typeof window.Peer === 'undefined') {
      homeMsg('The multiplayer library did not load. Check your internet connection, or ask whether your network blocks cdn.jsdelivr.net.');
      return false;
    }
    return true;
  }

  function startHosting(name) {
    if (!peerAvailable()) return;
    setBusy(true);
    homeMsg('Creating your room…', false);
    loadQuestions();

    const attempt = (n) => {
      const code = randomCode();
      const peer = new window.Peer(PEER_PREFIX + code, { debug: 1 });
      let opened = false;
      const timer = setTimeout(() => {
        if (!opened) { try { peer.destroy(); } catch (e) { /* ignore */ } setBusy(false); homeMsg('Could not reach the connection server. Check your internet and try again.'); }
      }, 15000);

      peer.on('open', () => {
        opened = true;
        clearTimeout(timer);
        net.peer = peer;
        net.role = 'host';
        net.code = code;
        net.me = { pid: 'host', name };
        initHostState(name);
        setBusy(false);
        homeMsg('');
        session.set(SESS_ROOM, code);
        broadcast();
        setInterval(hostHeartbeat, PING_MS);
      });
      peer.on('connection', onHostConnection);
      peer.on('disconnected', () => { if (!net.leaving) { try { peer.reconnect(); } catch (e) { /* ignore */ } } });
      peer.on('error', (err) => {
        if (!opened) {
          clearTimeout(timer);
          try { peer.destroy(); } catch (e) { /* ignore */ }
          if (err.type === 'unavailable-id' && n < 6) { attempt(n + 1); return; }
          setBusy(false);
          homeMsg('Could not create a room (' + (err.type || 'error') + '). Please try again.');
        } else {
          console.warn('Peer error', err);
        }
      });
    };
    attempt(0);
  }

  function joinRoom(rawCode, name) {
    if (!peerAvailable()) return;
    const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 4) { homeMsg('Enter the 4-character room code.'); return; }
    setBusy(true);
    homeMsg('Looking for room ' + code + '…', false);

    const peer = new window.Peer(undefined, { debug: 1 });
    net.peer = peer;
    net.role = 'client';
    net.code = code;
    net.me = { pid: getToken(), name };
    let connected = false;

    const fail = (text) => {
      try { peer.destroy(); } catch (e) { /* ignore */ }
      net.peer = null; net.hostConn = null; net.role = null;
      setBusy(false);
      homeMsg(text);
    };
    const timer = setTimeout(() => { if (!connected) fail('Could not reach that room. Check the code and try again.'); }, 14000);

    peer.on('open', () => {
      const conn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
      net.hostConn = conn;
      conn.on('open', () => {
        connected = true;
        clearTimeout(timer);
        session.set(SESS_ROOM, code);
        conn.send({ t: 'join', name, token: net.me.pid });
        lastHostMsg = Date.now();
        setInterval(() => {
          if (net.leaving) return;
          if (conn.open) { try { conn.send({ t: 'ping' }); } catch (e) { /* ignore */ } }
          if (Date.now() - lastHostMsg > STALE_MS + 10000) onHostLost();
        }, PING_MS);
      });
      conn.on('data', onClientData);
      conn.on('close', onHostLost);
      conn.on('error', () => { if (!connected) fail('Could not connect to that room.'); else onHostLost(); });
    });
    peer.on('disconnected', () => { if (!net.leaving) { try { peer.reconnect(); } catch (e) { /* ignore */ } } });
    peer.on('error', (err) => {
      if (!connected) {
        clearTimeout(timer);
        fail(err.type === 'peer-unavailable' ? 'Room ' + code + ' was not found. Check the code with your host.' : 'Connection problem (' + (err.type || 'error') + '). Please try again.');
      } else {
        console.warn('Peer error', err);
      }
    });
  }

  /* ---------------------------------------------------------
     CLIENT: incoming messages
     --------------------------------------------------------- */
  let lastRev = -1;
  let lastHostMsg = 0;

  function onClientData(msg) {
    if (!msg || typeof msg !== 'object') return;
    lastHostMsg = Date.now();
    if (msg.t === 'hb') return;
    if (msg.t === 'state' && msg.s) {
      if (msg.s.rev <= lastRev) return;      // stale or duplicate packet
      lastRev = msg.s.rev;
      setBusy(false);
      homeMsg('');
      applyState(msg.s, {});
    } else if (msg.t === 'reject') {
      net.leaving = true;
      try { net.peer && net.peer.destroy(); } catch (e) { /* ignore */ }
      net.peer = null; net.hostConn = null; net.role = null; net.leaving = false;
      setBusy(false);
      showScreen('home');
      homeMsg(msg.reason || 'Could not join that room.');
    }
  }

  function onHostLost() {
    if (net.leaving || net.role !== 'client') return;
    if (!S) { setBusy(false); homeMsg('Lost connection to the room.'); return; }
    $('#lostHostModal').classList.remove('hidden');
  }

  /* ---------------------------------------------------------
     PLAYER ACTIONS (same call path for host and clients)
     --------------------------------------------------------- */
  const myPid = () => net.me.pid;

  function actRoll() {
    $('#rollBtn').disabled = true;
    if (net.role === 'host') hostRoll('host');
    else if (net.hostConn && net.hostConn.open) net.hostConn.send({ t: 'roll' });
  }

  function actAnswer(qid, text) {
    if (net.role === 'host') hostAnswer('host', { qid, text });
    else if (net.hostConn && net.hostConn.open) net.hostConn.send({ t: 'answer', qid, text });
  }

  function leaveGame() {
    if (net.role === 'host' && S && S.phase !== 'lobby' && !window.confirm('Leaving will end the game for everyone. Leave anyway?')) return;
    net.leaving = true;
    try { net.peer && net.peer.destroy(); } catch (e) { /* ignore */ }
    window.location.reload();
  }

  /* ---------------------------------------------------------
     RENDERING (identical for host and clients — driven by snapshots)
     --------------------------------------------------------- */
  let S = null;                 // latest snapshot
  let S_extra = {};
  let seenSeq = -1;
  let lastRaftLen = 0;
  let rattling = false;
  const displayPos = {};        // pid -> space index currently drawn
  const animating = {};         // pid -> true while hopping
  const tokenEls = {};          // pid -> element

  function applyState(s, extra) {
    const prev = S;
    S = s;
    S_extra = extra || {};
    const first = !prev;

    if (s.phase === 'lobby') {
      showScreen('lobby');
      renderLobby();
      return;
    }

    showScreen('game');
    if (!prev || prev.phase === 'lobby') {
      lastRaftLen = 0;
      Object.keys(displayPos).forEach(k => delete displayPos[k]);
    }
    renderGame(prev, first);
  }

  /* ----- Lobby ----- */
  function renderLobby() {
    const isHost = net.role === 'host';
    $('#roomCode').textContent = S.code;
    const ul = $('#lobbyPlayers');
    ul.replaceChildren();
    S.players.forEach(p => {
      const li = el('li');
      const d = el('span', 'dot', initial(p.name));
      d.style.background = p.color;
      li.append(d, el('span', '', p.name + (p.pid === myPid() ? ' (you)' : '')));
      ul.append(li);
    });
    const fac = $('#lobbyFacilitator');
    if (!S.hostPlays) { fac.textContent = 'Host: ' + S.hostName + ' (running the game)'; fac.classList.remove('hidden'); }
    else fac.classList.add('hidden');

    $('#lobbyHostControls').classList.toggle('hidden', !isHost);
    $('#lobbyWaiting').classList.toggle('hidden', isHost);
    if (isHost) {
      $('#optHostPlays').checked = S.hostPlays;
      $('#optAutoContinue').checked = S.autoContinue;
      const qc = $('#lobbyQCount');
      qc.textContent = S.qCount + ' question' + (S.qCount === 1 ? '' : 's') + ' loaded.' +
        (S.qCount < 20 ? ' Add more in Teacher Mode (about 20+ makes the raft winnable).' : '');
      qc.classList.toggle('warn', S.qCount < 20);
      $('#startBtn').disabled = !S.players.some(p => p.connected);
    }
  }

  /* ----- Board construction (once) ----- */
  function spacePoint(i, radius) {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / N;
    return { x: 50 + radius * Math.cos(ang), y: 50 + radius * Math.sin(ang), ux: Math.cos(ang), uy: Math.sin(ang) };
  }

  function buildBoard() {
    const host = $('#spaces');
    host.replaceChildren();
    BOARD.forEach((type, i) => {
      const pt = spacePoint(i, RING_R);
      const cls = type === 'start' ? 'start' : ITEMS[type] ? 'item ' + type : 'blank';
      const d = el('div', 'space ' + cls);
      d.style.left = pt.x + '%';
      d.style.top = pt.y + '%';
      d.dataset.i = i;
      if (type === 'start') { d.textContent = '⚓'; d.title = 'Start beach'; }
      else if (ITEMS[type]) { d.textContent = ITEMS[type].emoji; d.title = ITEMS[type].label; }
      else d.title = 'Empty sand';
      host.append(d);
    });

    const slots = $('#raftSlots');
    slots.replaceChildren();
    for (let i = 0; i < TARGET; i++) slots.append(el('div', 'slot'));

    const sc = $('#supplyCounts');
    sc.replaceChildren();
    Object.keys(ITEMS).forEach(k => {
      const li = el('li');
      li.dataset.item = k;
      li.append(el('span', 'emo', ITEMS[k].emoji), el('span', '', ITEMS[k].label), el('span', 'n', '0'));
      sc.append(li);
    });

    const die = $('#die');
    die.replaceChildren();
    for (let i = 0; i < 9; i++) die.append(document.createElement('i'));
    setDie(6);
  }

  /* ----- Die ----- */
  const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  function setDie(v) {
    const on = PIPS[v] || [];
    $$('#die i').forEach((p, i) => p.classList.toggle('on', on.includes(i)));
    $('#die').setAttribute('aria-label', v ? 'Die showing ' + v : 'Die');
  }
  function rattleDie(finalValue, ms, done) {
    const d = $('#die');
    rattling = true;
    d.classList.add('rolling');
    const iv = setInterval(() => setDie(1 + Math.floor(Math.random() * 6)), 90);
    setTimeout(() => {
      clearInterval(iv);
      d.classList.remove('rolling');
      setDie(finalValue);
      rattling = false;
      if (done) done();
    }, ms);
  }

  /* ----- Movement animation (runs on every device from the same snapshot) ----- */
  function startMoveAnim() {
    const pid = S.roll.pid;
    const p = S.players.find(x => x.pid === pid);
    if (!p) return;
    const value = S.roll.value;
    const to = p.pos;
    const from = (((to - value) % N) + N) % N;
    displayPos[pid] = from;
    animating[pid] = true;
    renderTokens();

    rattleDie(value, DICE_MS, () => {
      let step = 0;
      const hop = () => {
        step++;
        displayPos[pid] = (from + step) % N;
        renderTokens();
        if (step < value) setTimeout(hop, STEP_MS);
        else { animating[pid] = false; setTimeout(renderTokens, 50); }
      };
      hop();
    });
  }

  function renderTokens() {
    const layer = $('#tokens');
    const groups = {};
    S.players.forEach(p => {
      if (!animating[p.pid]) displayPos[p.pid] = p.pos;
      const dp = displayPos[p.pid] == null ? p.pos : displayPos[p.pid];
      (groups[dp] = groups[dp] || []).push(p);
    });

    Object.keys(tokenEls).forEach(pid => {
      if (!S.players.some(p => p.pid === pid)) { tokenEls[pid].remove(); delete tokenEls[pid]; }
    });

    Object.keys(groups).forEach(pos => {
      const arr = groups[pos];
      const pt = spacePoint(Number(pos), RING_R + TOKEN_OFF);
      const spacing = arr.length <= 4 ? 5.6 : 3.3;
      arr.forEach((p, k) => {
        let t = tokenEls[p.pid];
        if (!t) { t = el('div', 'token'); layer.append(t); tokenEls[p.pid] = t; }
        const off = (k - (arr.length - 1) / 2) * spacing;
        t.style.left = (pt.x + -pt.uy * off) + '%';
        t.style.top = (pt.y + pt.ux * off) + '%';
        t.style.background = p.color;
        t.textContent = initial(p.name);
        t.title = p.name;
        t.classList.toggle('me', p.pid === myPid());
        t.classList.toggle('current', p.pid === S.turnPid && (S.phase === 'roll' || S.phase === 'moving'));
        t.classList.toggle('offline', !p.connected);
      });
    });
  }

  /* ----- Main game render ----- */
  function renderGame(prev, first) {
    // Kick off the move animation exactly once per roll.
    if (S.phase === 'moving') {
      if (S.roll.seq !== seenSeq) {
        seenSeq = S.roll.seq;
        if (first) setDie(S.roll.value); else startMoveAnim();
      }
    } else {
      seenSeq = S.roll.seq;
      if (!rattling && S.roll.value) setDie(S.roll.value);
    }

    $('#roomChip').textContent = S.code;
    renderTokens();
    renderBoardHighlight();
    renderRaft(first);
    renderPanel();
    renderQuestion();
    renderEnd(prev);
  }

  function renderBoardHighlight() {
    const landedPos = (S.phase === 'question' || S.phase === 'reveal') && S.landed ? S.landed.pos : -1;
    $$('#spaces .space').forEach(sp => sp.classList.toggle('landed', Number(sp.dataset.i) === landedPos));
  }

  function floatText(text) {
    const f = el('div', 'floatgain', text);
    $('#board').append(f);
    setTimeout(() => f.remove(), 2000);
  }

  function renderRaft(first) {
    const len = S.raft.length;
    if (len < lastRaftLen) lastRaftLen = 0;
    $$('#raftSlots .slot').forEach((sl, i) => {
      const it = S.raft[i];
      if (it) {
        if (sl.dataset.item !== it) {
          sl.dataset.item = it;
          sl.textContent = ITEMS[it].emoji;
          sl.className = 'slot filled';
          if (!first && i >= lastRaftLen) { void sl.offsetWidth; sl.classList.add('pop'); }
        }
      } else if (sl.dataset.item) {
        delete sl.dataset.item;
        sl.textContent = '';
        sl.className = 'slot';
      }
    });
    if (!first && len > lastRaftLen) {
      const it = S.raft[len - 1];
      floatText('+1 ' + ITEMS[it].emoji + ' ' + ITEMS[it].label + '!');
    }
    lastRaftLen = len;

    $('#raft').style.setProperty('--p', String(Math.min(1, len / TARGET)));
    $('#raftCount').textContent = String(len);

    const counts = {};
    S.raft.forEach(it => { counts[it] = (counts[it] || 0) + 1; });
    $$('#supplyCounts li').forEach(li => { li.querySelector('.n').textContent = String(counts[li.dataset.item] || 0); });
  }

  function renderPanel() {
    const isHost = net.role === 'host';
    const me = myPid();
    const cur = S.players.find(p => p.pid === S.turnPid);
    const mine = !!cur && cur.pid === me;

    // Turn text + roll button
    let text = '';
    switch (S.phase) {
      case 'roll': text = mine ? 'Your turn! Roll the die.' : (cur ? cur.name + "'s turn to roll…" : 'Waiting for players…'); break;
      case 'moving': text = (cur ? cur.name : 'Someone') + ' is on the move…'; break;
      case 'question': text = 'Everyone answers the question!'; break;
      case 'reveal': text = 'Checking answers…'; break;
      case 'won': text = 'You escaped!'; break;
      case 'lost': text = 'Stranded on the island.'; break;
      default: text = '';
    }
    $('#turnText').textContent = text;

    const rb = $('#rollBtn');
    const canRoll = S.phase === 'roll' && cur && (mine || isHost);
    rb.disabled = !canRoll;
    rb.textContent = canRoll && !mine ? 'Roll for ' + cur.name : 'Roll the die';
    rb.classList.toggle('ghost', !!(canRoll && !mine));

    // Questions left
    $('#deckLeft').textContent = String(S.deckLeft);
    $('#deckTotal').textContent = 'of ' + S.totalQ;
    $('#deckBar').style.width = (S.totalQ ? (S.deckLeft / S.totalQ) * 100 : 0) + '%';
    $('#deckCard').classList.toggle('deck-card-low', S.deckLeft <= 3);

    // Crew
    const ul = $('#playerList');
    ul.replaceChildren();
    S.players.forEach(p => {
      const li = el('li', 'player' + (p.pid === S.turnPid && (S.phase === 'roll' || S.phase === 'moving') ? ' turn' : '') + (p.connected ? '' : ' offline'));
      const d = el('span', 'dot', initial(p.name));
      d.style.background = p.color;
      li.append(d, el('span', 'pname', p.name + (p.pid === me ? ' (you)' : '')));
      if (p.isHost) li.append(el('span', 'tag', 'host'));
      if (!p.connected) li.append(el('span', 'tag off', 'offline'));
      if (S.phase === 'question' && S.answered.includes(p.pid)) li.append(el('span', 'tag ok', '✓ answered'));
      ul.append(li);
    });
    if (!S.hostPlays) {
      const li = el('li', 'player');
      li.append(el('span', 'pname', S.hostName + ' (running the game)'));
      ul.prepend(li);
    }

    // Log
    const log = $('#logList');
    log.replaceChildren();
    S.log.slice().reverse().forEach(m => log.append(el('li', '', m)));

    // Host controls
    $('#hostControls').classList.toggle('hidden', !isHost);
    if (isHost) $('#hcAutoContinue').checked = S.autoContinue;
  }

  /* ----- Question / reveal modal ----- */
  let qView = { id: null, submitted: false, revealStarted: false };

  function renderQuestion() {
    const modal = $('#qModal');
    const active = (S.phase === 'question' || S.phase === 'reveal') && S.question;
    if (!active) {
      modal.classList.add('hidden');
      qView = { id: null, submitted: false, revealStarted: false };
      return;
    }
    modal.classList.remove('hidden');

    const me = myPid();
    const isHost = net.role === 'host';
    const isNew = qView.id !== S.question.id;
    if (isNew) {
      qView = { id: S.question.id, submitted: false, revealStarted: false };
      $('#qInput').value = '';
    }
    const imPlayer = S.players.some(p => p.pid === me);
    const answered = S.answered.includes(me) || qView.submitted;

    // Where did we land?
    const L = S.landed;
    const landed = $('#qLanded');
    if (L) {
      if (L.gained) { landed.textContent = L.name + ' found ' + ITEMS[L.type].label + ' ' + ITEMS[L.type].emoji + ' and added it to the raft!'; landed.className = 'q-landed gain'; }
      else if (ITEMS[L.type]) { landed.textContent = L.name + ' landed on ' + ITEMS[L.type].label + ', but the raft is already full.'; landed.className = 'q-landed'; }
      else { landed.textContent = L.name + ' landed on ' + (L.type === 'start' ? 'the start beach.' : 'empty sand.'); landed.className = 'q-landed'; }
    }

    const full = S.raft.length >= S.target;
    const leftAfter = S.deckLeft;
    $('#qMeta').textContent = (full ? 'Last question: answer to launch the raft! ' : '') +
      'Question ' + S.question.num + ' · ' + leftAfter + ' more after this one';
    $('#qText').textContent = S.question.text;

    const isQ = S.phase === 'question';
    $('#qAnswerArea').classList.toggle('hidden', !(isQ && imPlayer && !answered));
    const waitEl = $('#qWait');
    const waiting = S.players.filter(p => p.connected && !S.answered.includes(p.pid)).length;
    if (isQ && imPlayer && answered) {
      waitEl.textContent = waiting > 0 ? 'Answer locked in! Waiting for ' + waiting + ' more…' : 'Answer locked in!';
      waitEl.classList.remove('hidden');
    } else if (isQ && !imPlayer) {
      waitEl.textContent = 'Waiting for ' + waiting + ' player' + (waiting === 1 ? '' : 's') + ' to answer…';
      waitEl.classList.remove('hidden');
    } else waitEl.classList.add('hidden');

    const ha = $('#qHostAnswer');
    if (isQ && S_extra.hostAnswer) { ha.textContent = 'Correct answer (only you can see this): ' + S_extra.hostAnswer; ha.classList.remove('hidden'); }
    else ha.classList.add('hidden');

    // Who has answered
    const prog = $('#qProgress');
    prog.replaceChildren();
    if (isQ) {
      S.players.filter(p => p.connected).forEach(p => {
        const done = S.answered.includes(p.pid);
        const li = el('li', done ? 'done' : '');
        const d = el('span', 'dot', initial(p.name));
        d.style.background = p.color;
        li.append(d, el('span', '', p.name + (done ? ' ✓' : ' …')));
        prog.append(li);
      });
    }
    prog.classList.toggle('hidden', !isQ);

    // Reveal
    const rev = $('#qReveal');
    rev.classList.toggle('hidden', S.phase !== 'reveal');
    if (S.phase === 'reveal' && S.reveal) {
      $('#qCorrect').textContent = S.reveal.answer;
      const mineR = S.reveal.results.find(r => r.pid === me);
      const verdict = $('#qVerdict');
      if (mineR) {
        verdict.textContent = mineR.correct ? 'You got it!' : 'Not quite, nice try!';
        verdict.className = 'q-verdict ' + (mineR.correct ? 'good' : 'meh');
      } else {
        const right = S.reveal.results.filter(r => r.correct).length;
        verdict.textContent = right + ' of ' + S.reveal.results.length + ' answered correctly';
        verdict.className = 'q-verdict meh';
      }
      const rl = $('#qResults');
      rl.replaceChildren();
      S.reveal.results.forEach(r => {
        const p = S.players.find(x => x.pid === r.pid);
        if (!p) return;
        const li = el('li', r.text === null ? '' : (r.correct ? 'right' : 'wrong'));
        const d = el('span', 'dot', initial(p.name));
        d.style.background = p.color;
        li.append(d, el('span', '', p.name), el('span', 'mark', r.text === null ? '–' : (r.correct ? '✓' : '✗')), el('span', 'ans', r.text === null ? 'no answer' : r.text));
        rl.append(li);
      });

      const cd = $('#qCountdown');
      cd.classList.toggle('hidden', !S.autoContinue);
      if (S.autoContinue && !qView.revealStarted) {
        cd.style.setProperty('--reveal-ms', REVEAL_MS + 'ms');
        cd.classList.remove('run');
        void cd.offsetWidth;
        cd.classList.add('run');
      }
      qView.revealStarted = true;
      $('#qNextNote').textContent = S.autoContinue
        ? 'The next turn starts in a moment.'
        : (isHost ? 'Press “Next turn” when you are ready.' : 'Waiting for the host to start the next turn…');
    }

    $('#qSkip').classList.toggle('hidden', !(isHost && isQ));
    $('#qContinue').classList.toggle('hidden', !(isHost && S.phase === 'reveal'));

    if (isNew && isQ && imPlayer) setTimeout(() => { const i = $('#qInput'); if (!i.closest('.hidden')) i.focus(); }, 60);
  }

  function submitAnswer() {
    if (!S || S.phase !== 'question' || !S.question) return;
    const input = $('#qInput');
    const text = input.value.trim();
    if (!text) { input.focus(); toast('Type an answer first.'); return; }
    if (qView.submitted) return;
    qView.submitted = true;
    $('#qAnswerArea').classList.add('hidden');
    const w = $('#qWait');
    w.textContent = 'Answer locked in!';
    w.classList.remove('hidden');
    actAnswer(S.question.id, text);
  }

  /* ----- End screens ----- */
  function renderEnd(prev) {
    const m = $('#endModal');
    if (S.phase !== 'won' && S.phase !== 'lost') { m.classList.add('hidden'); return; }
    m.classList.remove('hidden');
    m.dataset.result = S.phase;
    const won = S.phase === 'won';
    $('#endIcon').textContent = won ? '🛶' : '🏝️';
    $('#endTitle').textContent = won ? 'You escaped the island!' : 'Oh no! Time ran out!';
    $('#endMsg').textContent = won
      ? 'The life raft is ready. Great teamwork, castaways!'
      : 'The island is your home now.';
    $('#endStats').textContent = S.raft.length + ' of ' + S.target + ' supplies collected · ' + (S.totalQ - S.deckLeft) + ' of ' + S.totalQ + ' questions used';
    const isHost = net.role === 'host';
    $('#playAgainBtn').classList.toggle('hidden', !isHost);
    $('#endWaiting').classList.toggle('hidden', isHost);
    if (won && (!prev || prev.phase !== 'won')) launchConfetti();
  }

  function launchConfetti() {
    const box = $('#confetti');
    const bits = ['🎉', '🌴', '🥭', '🪵', '⭐', '🌊', '🛶'];
    for (let i = 0; i < 48; i++) {
      const s = el('span', '', bits[Math.floor(Math.random() * bits.length)]);
      s.style.left = Math.random() * 100 + '%';
      s.style.animationDuration = 3 + Math.random() * 3 + 's';
      s.style.animationDelay = Math.random() * 1.5 + 's';
      s.style.fontSize = 1.2 + Math.random() * 1.6 + 'rem';
      box.append(s);
    }
    setTimeout(() => box.replaceChildren(), 7500);
  }

  /* ---------------------------------------------------------
     TEACHER MODE
     - Hidden: Alt+Shift+T or Ctrl+Shift+T (some browsers reserve the
       latter), or triple-click the invisible bottom-left corner.
     - PIN is checked here in JavaScript only; it never appears in the HTML.
     --------------------------------------------------------- */
  let pinFails = 0;
  let pinLockedUntil = 0;
  let editingId = null;

  function openPin() {
    if ($('#teacherModal').classList.contains('hidden') === false) return;
    if (!$('#pinModal').classList.contains('hidden')) return;
    const wait = Math.ceil((pinLockedUntil - Date.now()) / 1000);
    $('#pinMsg').textContent = wait > 0 ? 'Too many tries. Wait ' + wait + ' seconds.' : '';
    $('#pinMsg').classList.toggle('error', wait > 0);
    $('#pinInput').value = '';
    $('#pinModal').classList.remove('hidden');
    setTimeout(() => $('#pinInput').focus(), 30);
  }
  function closePin() { $('#pinModal').classList.add('hidden'); $('#pinInput').value = ''; }

  function submitPin() {
    const now = Date.now();
    if (now < pinLockedUntil) {
      $('#pinMsg').textContent = 'Too many tries. Wait ' + Math.ceil((pinLockedUntil - now) / 1000) + ' seconds.';
      $('#pinMsg').classList.add('error');
      return;
    }
    if ($('#pinInput').value.trim() === TEACHER_PIN) {
      pinFails = 0;
      closePin();
      openTeacher();
    } else {
      pinFails++;
      $('#pinInput').value = '';
      $('#pinMsg').classList.add('error');
      if (pinFails >= 5) { pinFails = 0; pinLockedUntil = now + 30000; $('#pinMsg').textContent = 'Too many tries. Wait 30 seconds.'; }
      else $('#pinMsg').textContent = 'That PIN is not right.';
      $('#pinInput').focus();
    }
  }

  function openTeacher() {
    loadQuestions();
    editingId = null;
    renderTeacher();
    $('#teacherModal').classList.remove('hidden');
    setTimeout(() => $('#tNewQ').focus(), 30);
  }
  function closeTeacher() {
    $('#teacherModal').classList.add('hidden');
    if (H && H.phase === 'lobby') broadcast();   // refresh the "questions loaded" count
    else if (S && S.phase === 'lobby') renderLobby();
    updateLobbyCountFromStorage();
  }
  function updateLobbyCountFromStorage() {
    if (net.role === 'host' && S && S.phase === 'lobby') { S.qCount = questions.length; renderLobby(); }
  }

  function renderTeacher() {
    const cnt = $('#tCount');
    cnt.textContent = questions.length + ' question' + (questions.length === 1 ? '' : 's') + ' saved.' +
      (questions.length < 20 ? ' Tip: players need about 16 turns on average to fill the raft, so 20 to 30 questions makes a fair game.' : '');
    cnt.classList.toggle('warn', questions.length < 20);

    const list = $('#tList');
    list.replaceChildren();
    if (!questions.length) { list.append(el('li', 't-empty', 'No questions yet. Add one above.')); return; }

    questions.forEach(q => {
      const li = el('li', 'trow');
      if (editingId === q.id) {
        const qi = el('input'); qi.type = 'text'; qi.value = q.q; qi.maxLength = 200; qi.setAttribute('aria-label', 'Edit question');
        const ai = el('input'); ai.type = 'text'; ai.value = q.a; ai.maxLength = 120; ai.setAttribute('aria-label', 'Edit answer');
        const btns = el('div', 'tbtns');
        const save = el('button', 'btn small palm', 'Save'); save.type = 'button';
        const cancel = el('button', 'btn small ghost', 'Cancel'); cancel.type = 'button';
        const doSave = () => {
          if (!qi.value.trim() || !ai.value.trim()) { toast('Question and answer cannot be empty.'); return; }
          q.q = qi.value.trim(); q.a = ai.value.trim();
          saveQuestions(); editingId = null; renderTeacher();
        };
        save.addEventListener('click', doSave);
        cancel.addEventListener('click', () => { editingId = null; renderTeacher(); });
        [qi, ai].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } }));
        btns.append(save, cancel);
        li.append(qi, ai, btns);
        setTimeout(() => qi.focus(), 20);
      } else {
        const edit = el('button', 'btn small ghost', 'Edit'); edit.type = 'button';
        const del = el('button', 'btn small ghost danger', 'Delete'); del.type = 'button';
        edit.addEventListener('click', () => { editingId = q.id; renderTeacher(); });
        del.addEventListener('click', () => {
          if (!window.confirm('Delete this question?')) return;
          questions = questions.filter(x => x.id !== q.id);
          saveQuestions(); renderTeacher();
        });
        const btns = el('div', 'tbtns'); btns.append(edit, del);
        li.append(el('div', 'tq', q.q), el('div', 'ta', displayAnswer(q.a)), btns);
      }
      list.append(li);
    });
  }

  function addQuestion(qText, aText) {
    qText = qText.trim(); aText = aText.trim();
    if (!qText || !aText) return false;
    questions.push({ id: uid(), q: qText, a: aText });
    saveQuestions();
    return true;
  }

  function bulkAdd() {
    const ta = $('#tBulk');
    let added = 0, skipped = 0;
    ta.value.split(/\r?\n/).forEach(line => {
      if (!line.trim()) return;
      let parts = line.includes('\t') ? line.split('\t') : line.split('=>');
      if (parts.length < 2) { skipped++; return; }
      const q = parts[0], a = parts.slice(1).join(' ').replace(/\t/g, ' ');
      if (addQuestion(q, a)) added++; else skipped++;
    });
    ta.value = '';
    renderTeacher();
    toast(added + ' added' + (skipped ? ', ' + skipped + ' line' + (skipped === 1 ? '' : 's') + ' skipped' : '') + '.');
  }

  function exportQuestions() {
    const data = JSON.stringify(questions.map(({ q, a }) => ({ q, a })), null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const a = el('a'); a.href = url; a.download = 'escape-the-island-questions.json';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function importQuestions(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const arr = JSON.parse(String(reader.result));
        if (!Array.isArray(arr)) throw new Error('not an array');
        let added = 0;
        arr.forEach(item => {
          const q = item && (item.q || item.question), a = item && (item.a || item.answer);
          if (typeof q === 'string' && typeof a === 'string' && addQuestion(q, a)) added++;
        });
        renderTeacher();
        toast(added + ' question' + (added === 1 ? '' : 's') + ' imported.');
      } catch (e) { toast('That file could not be read. Use a file exported from this game.'); }
    };
    reader.readAsText(file);
  }

  /* ---------------------------------------------------------
     WIRING
     --------------------------------------------------------- */
  function copyText(text, okMsg) {
    const fallback = () => {
      const t = el('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.append(t); t.select();
      try { document.execCommand('copy'); toast(okMsg); } catch (e) { toast('Copy failed. Select and copy it by hand.'); }
      t.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast(okMsg), fallback);
    else fallback();
  }

  function init() {
    buildBoard();
    loadQuestions();

    // Prefill from storage / invite link
    const params = new URLSearchParams(window.location.search);
    $('#nameInput').value = local.get(STORE_NAME, '') || '';
    const fromLink = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    $('#codeInput').value = fromLink || session.get(SESS_ROOM, '') || '';

    const readName = () => {
      const n = cleanName($('#nameInput').value);
      if (!n) { homeMsg('Type your name first.'); $('#nameInput').focus(); return null; }
      local.set(STORE_NAME, n);
      return n;
    };

    $('#hostBtn').addEventListener('click', () => { const n = readName(); if (n) startHosting(n); });
    $('#joinBtn').addEventListener('click', () => { const n = readName(); if (n) joinRoom($('#codeInput').value, n); });
    $('#codeInput').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    $('#codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#joinBtn').click(); });
    $('#nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') ($('#codeInput').value ? $('#joinBtn') : $('#hostBtn')).click(); });

    // Lobby
    $('#copyCodeBtn').addEventListener('click', () => copyText(net.code, 'Room code copied.'));
    $('#copyLinkBtn').addEventListener('click', () => copyText(window.location.origin + window.location.pathname + '?room=' + net.code, 'Join link copied.'));
    $('#startBtn').addEventListener('click', () => { if (net.role === 'host') hostStart(); });
    $('#optHostPlays').addEventListener('change', e => { if (net.role === 'host') hostSetHostPlays(e.target.checked); });
    $('#optAutoContinue').addEventListener('change', e => { if (net.role === 'host') { H.autoContinue = e.target.checked; broadcast(); } });
    $('#lobbyLeaveBtn').addEventListener('click', leaveGame);

    // Game
    $('#rollBtn').addEventListener('click', actRoll);
    $('#leaveBtn').addEventListener('click', leaveGame);
    $('#hcAutoContinue').addEventListener('change', e => { if (net.role === 'host') { H.autoContinue = e.target.checked; broadcast(); } });
    $('#restartBtn').addEventListener('click', () => {
      if (net.role === 'host' && window.confirm('Restart the game with fresh questions? Everyone goes back to the start.')) hostStart();
    });

    // Question modal
    $('#qSubmit').addEventListener('click', submitAnswer);
    $('#qInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitAnswer(); } });
    $('#qSkip').addEventListener('click', () => { if (net.role === 'host') resolveQuestion(); });
    $('#qContinue').addEventListener('click', () => { if (net.role === 'host') hostContinue(); });

    // End modal
    $('#playAgainBtn').addEventListener('click', () => { if (net.role === 'host') hostStart(); });
    $('#endLeaveBtn').addEventListener('click', leaveGame);
    $('#lostHostBtn').addEventListener('click', () => { net.leaving = true; window.location.reload(); });

    // Teacher mode
    document.addEventListener('keydown', e => {
      if (e.shiftKey && e.code === 'KeyT' && (e.ctrlKey || e.altKey)) { e.preventDefault(); openPin(); }
      if (e.key === 'Escape') {
        if (!$('#pinModal').classList.contains('hidden')) closePin();
        else if (!$('#teacherModal').classList.contains('hidden')) closeTeacher();
      }
    });
    let corner = [];
    $('#hotCorner').addEventListener('click', () => {
      const now = Date.now();
      corner = corner.filter(t => now - t < 1500).concat(now);
      if (corner.length >= 3) { corner = []; openPin(); }
    });
    $('#pinOk').addEventListener('click', submitPin);
    $('#pinCancel').addEventListener('click', closePin);
    $('#pinInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitPin(); } });
    $('#tClose').addEventListener('click', closeTeacher);
    $('#tAddForm').addEventListener('submit', e => {
      e.preventDefault();
      if (addQuestion($('#tNewQ').value, $('#tNewA').value)) {
        $('#tNewQ').value = ''; $('#tNewA').value = '';
        renderTeacher();
        $('#tNewQ').focus();
      }
    });
    $('#tBulkBtn').addEventListener('click', bulkAdd);
    $('#tExport').addEventListener('click', exportQuestions);
    $('#tImport').addEventListener('change', e => { importQuestions(e.target.files[0]); e.target.value = ''; });
    $('#tSamples').addEventListener('click', () => {
      if (!window.confirm('Replace all of your questions with the sample questions?')) return;
      questions = DEFAULT_QUESTIONS.map(([q, a]) => ({ id: uid(), q, a }));
      saveQuestions(); renderTeacher();
    });
    $('#tClear').addEventListener('click', () => {
      if (!window.confirm('Delete ALL questions? This cannot be undone.')) return;
      questions = []; saveQuestions(); renderTeacher();
    });

    // Close connections cleanly when a tab is closed so the host notices right away
    window.addEventListener('pagehide', e => {
      if (e.persisted || !net.peer) return;
      net.leaving = true;
      try { net.peer.destroy(); } catch (err) { /* ignore */ }
    });

    // Protect a running host game from an accidental tab close
    window.addEventListener('beforeunload', e => {
      if (net.role === 'host' && S && S.phase !== 'lobby' && S.phase !== 'won' && S.phase !== 'lost' && !net.leaving) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    showScreen('home');
  }

  init();
})();
