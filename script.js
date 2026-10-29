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
  const STORE_Q = 'escapeIsland.questions.v2';
  const STORE_Q_OLD = 'escapeIsland.questions.v1';
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

  // [question, correct answer, [wrong answers]]
  const DEFAULT_QUESTIONS = [
    ['What is 7 x 8?', '56', ['54', '63', '48']],
    ['What is 9 + 6?', '15', ['14', '16', '13']],
    ['What is 100 - 35?', '65', ['75', '55', '64']],
    ['What is 6 x 7?', '42', ['36', '48', '49']],
    ['How many sides does a hexagon have?', '6', ['5', '8', '7']],
    ['How many minutes are in one hour?', '60', ['30', '100', '24']],
    ['How many days are in one week?', '7', ['5', '6', '10']],
    ['Which is bigger: 1/2 or 1/4?', '1/2', ['1/4', 'They are the same size']],
    ['What planet do we live on?', 'Earth', ['Mars', 'Venus', 'Jupiter']],
    ['What do plants need from the sun to make food?', 'Sunlight', ['Wind', 'Sand', 'Snow']],
    ['What force pulls objects toward the Earth?', 'Gravity', ['Magnetism', 'Friction', 'Static']],
    ['What do we call animals that eat only plants?', 'Herbivores', ['Carnivores', 'Omnivores', 'Scavengers']],
    ['What is the largest ocean on Earth?', 'Pacific Ocean', ['Atlantic Ocean', 'Indian Ocean', 'Arctic Ocean']],
    ['What is the capital city of Colorado?', 'Denver', ['Boulder', 'Colorado Springs', 'Aurora']],
    ['What is the nickname of Colorado?', 'The Centennial State', ['The Sunshine State', 'The Lone Star State']],
    ['What is the plural of "mouse"?', 'Mice', ['Mouses', 'Mices']],
    ['What is the past tense of "run"?', 'Ran', ['Runned', 'Runs']],
    ['What is the opposite of "ancient"?', 'Modern', ['Old', 'Tiny', 'Dusty']],
    ['A noun that names a specific person or place is called a ___ noun.', 'Proper', ['Common', 'Plural', 'Action']],
    ['What do we call water that falls from clouds as rain, snow, or hail?', 'Precipitation', ['Evaporation', 'Condensation', 'Erosion']],
    ['What do we call a story that is made up and not real?', 'Fiction', ['Nonfiction', 'Biography', 'Atlas']],
    ['How many legs does an insect have?', '6', ['4', '8', '10']],
    ['Which of these is a state of matter?', 'Solid', ['Sound', 'Shadow', 'Heat']]
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
     Each question: { id, q, a (correct answer), wrong: [1 to 3 wrong answers] }
     --------------------------------------------------------- */
  let questions = [];
  const LETTERS = ['A', 'B', 'C', 'D'];

  const cleanText = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
  const sampleQuestions = () => DEFAULT_QUESTIONS.map(([q, a, w]) => ({ id: uid(), q, a, wrong: w.slice() }));
  const playable = () => questions.filter(q => q.wrong.length >= 1);

  // Returns { q } for a clean question object, or { error } describing what is missing.
  function buildQuestion(q, a, wrongList, id) {
    q = cleanText(q, 200);
    a = cleanText(a, 80);
    if (!q) return { error: 'Type the question.' };
    if (!a) return { error: 'Type the correct answer.' };
    const seen = new Set([a.toLowerCase()]);
    const wrong = [];
    wrongList.forEach(w => {
      w = cleanText(w, 80);
      if (w && !seen.has(w.toLowerCase())) { seen.add(w.toLowerCase()); wrong.push(w); }
    });
    if (!wrong.length) return { error: 'Add at least one wrong answer (different from the correct one).' };
    return { q: { id: id || uid(), q, a, wrong: wrong.slice(0, 3) } };
  }

  function loadQuestions() {
    const raw = local.get(STORE_Q);
    if (raw !== null) {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          questions = arr
            .filter(x => x && typeof x.q === 'string' && typeof x.a === 'string' && x.q.trim() && x.a.trim())
            .map(x => ({
              id: x.id || uid(), q: x.q.trim(), a: x.a.trim(),
              wrong: Array.isArray(x.wrong) ? x.wrong.map(w => cleanText(w, 80)).filter(Boolean).slice(0, 3) : []
            }));
          return;
        }
      } catch (e) { /* fall through to samples */ }
    }
    // First run of this version: start with the samples, and carry over any questions
    // you typed in the older typed-answer version (they will be flagged as needing wrong answers).
    questions = sampleQuestions();
    const old = local.get(STORE_Q_OLD);
    if (old) {
      try {
        const sampleTexts = new Set(DEFAULT_QUESTIONS.map(d => d[0]));
        JSON.parse(old).forEach(o => {
          if (o && typeof o.q === 'string' && typeof o.a === 'string' && !sampleTexts.has(o.q.trim())) {
            const a = cleanText(String(o.a).split('|')[0], 80);
            if (o.q.trim() && a) questions.push({ id: uid(), q: o.q.trim(), a, wrong: [] });
          }
        });
      } catch (e) { /* ignore */ }
    }
    saveQuestions();
  }
  function saveQuestions() { local.set(STORE_Q, JSON.stringify(questions)); }

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
      board: null,               // whiteboard currently shared with the class
      paused: false,             // teacher is using the whiteboard: no auto-advance
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

  // Public snapshot. It never contains anyone's answer or the correct answer
  // (until the reveal). Per-person details are added by withPrivate().
  function snapshot() {
    const inQ = (H.phase === 'question' || H.phase === 'reveal') && H.current;
    const cur = currentPlayer();
    const ready = playable().length;
    return {
      rev: H.rev,
      phase: H.phase,
      code: net.code,
      hostName: H.hostName,
      hostPlays: H.hostPlays,
      autoContinue: H.autoContinue,
      paused: H.paused,
      players: H.players.map(p => ({ pid: p.pid, name: p.name, color: p.color, pos: p.pos, connected: p.connected, isHost: p.pid === 'host' })),
      turnPid: cur ? cur.pid : null,
      raft: H.raft.slice(),
      target: TARGET,
      roll: { seq: H.roll.seq, value: H.roll.value, pid: H.roll.pid },
      deckLeft: H.deck.length,
      totalQ: H.totalQ,
      qCount: ready,
      qSkipped: questions.length - ready,
      question: inQ ? { id: H.current.id, num: H.asked, text: H.current.q, choices: H.current.choices.slice() } : null,
      answered: Object.keys(H.answers),            // who has answered, not what they picked
      landed: H.landed,
      reveal: H.phase === 'reveal' ? H.reveal : null,   // { correctIdx, right, total }
      boardShared: !!H.board,
      log: H.log.slice(-6)
    };
  }

  // Each student only ever receives THEIR OWN pick (and whether it was right, after the reveal).
  function withPrivate(base, pid) {
    const s = Object.assign({}, base, { mine: null });
    if (pid && H.current && (H.phase === 'question' || H.phase === 'reveal') && Object.prototype.hasOwnProperty.call(H.answers, pid)) {
      s.mine = { choice: H.answers[pid] };
      if (H.phase === 'reveal') s.mine.correct = H.answers[pid] === H.current.correctIdx;
    }
    return s;
  }

  // Extra data only the host's own screen gets.
  function hostExtra() {
    const extra = {};
    if (H.current && (H.phase === 'question' || H.phase === 'reveal')) {
      extra.picks = Object.assign({}, H.answers);          // pid -> choice index
      if (H.phase === 'question' && !H.players.some(p => p.pid === 'host')) extra.correctIdx = H.current.correctIdx;
    }
    return extra;
  }

  function broadcast() {
    H.rev++;
    const base = snapshot();
    Object.values(net.conns).forEach(c => {
      if (c && c.open) {
        try { c.send({ t: 'state', s: withPrivate(base, H.peerToPid[c.peer]) }); } catch (e) { /* ignore */ }
      }
    });
    applyState(withPrivate(base, 'host'), hostExtra());
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
  function sendToAll(msg) {
    Object.values(net.conns).forEach(c => { if (c && c.open) { try { c.send(msg); } catch (e) { /* ignore */ } } });
  }

  function hostStart() {
    loadQuestions();
    const ready = playable();
    if (!ready.length) { toast('Add at least one question with answer choices in Teacher Mode first.'); return; }
    if (!H.players.some(p => p.connected)) { toast('Wait for at least one player to join.'); return; }

    clearTimeout(H.timer);
    H.deck = shuffle(ready.map(q => ({ id: uid(), q: q.q, a: q.a, wrong: q.wrong.slice() })));
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
    H.paused = false;
    H.log = [];
    hostClearBoard();
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
    // Mix the correct answer in with the wrong ones. One shuffle per question, so
    // every student sees the same order (handy when you talk it through).
    const opts = shuffle([{ t: q.a, ok: true }].concat(q.wrong.map(t => ({ t, ok: false }))));
    H.current = { id: q.id, q: q.q, choices: opts.map(o => o.t), correctIdx: opts.findIndex(o => o.ok) };
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
    if (!Number.isInteger(msg.choice) || msg.choice < 0 || msg.choice >= H.current.choices.length) return;
    if (Object.prototype.hasOwnProperty.call(H.answers, pid)) return;
    H.answers[pid] = msg.choice;
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
    const who = Object.keys(H.answers);
    const right = who.filter(pid => H.answers[pid] === H.current.correctIdx).length;
    H.reveal = { correctIdx: H.current.correctIdx, right, total: who.length };
    H.phase = 'reveal';
    hostLog(who.length ? `${right} of ${who.length} answered correctly.` : 'Nobody answered.');
    broadcast();

    clearTimeout(H.timer);
    if (H.autoContinue && !H.paused) H.timer = setTimeout(hostContinue, REVEAL_MS);
  }

  function hostContinue() {
    if (H.phase !== 'reveal') return;
    clearTimeout(H.timer);
    H.paused = false;
    hostClearBoard();
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

  /* ----- Host: whiteboard sharing ----- */
  // The teacher opening the whiteboard pauses auto-advance so the class is not
  // moved on mid-explanation. "Next turn" resumes.
  function hostPause() {
    if (!H || H.paused) return;
    if (H.phase === 'question' || H.phase === 'reveal') {
      H.paused = true;
      if (H.phase === 'reveal') clearTimeout(H.timer);
      broadcast();
    }
  }

  function hostShareBoard(strokes) {
    if (!H || !strokes.length) return 'empty';
    const board = { id: uid(6), strokes };
    if (JSON.stringify(board).length > 400000) return 'toolarge';
    H.board = board;
    Object.values(net.conns).forEach(c => { if (c && c.open) sendBoard(c, board); });
    broadcast();
    return 'ok';
  }

  // Sent in small pieces so it works on every browser's data-channel size limit.
  function sendBoard(conn, board) {
    const json = JSON.stringify(board);
    const size = 12000, n = Math.ceil(json.length / size);
    try {
      for (let i = 0; i < n; i++) conn.send({ t: 'boardpart', id: board.id, i, n, d: json.slice(i * size, (i + 1) * size) });
    } catch (e) { /* ignore */ }
  }

  function hostClearBoard() {
    if (H && H.board) { H.board = null; sendToAll({ t: 'board', board: null }); }
  }
  function hostHideBoard() {
    if (!H) return;
    H.board = null;
    sendToAll({ t: 'board', board: null });
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
    if (H.board) sendBoard(conn, H.board);
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
  let boardData = null;   // whiteboard drawing from the teacher (students)
  let boardAsm = null;    // pieces of a drawing that is still arriving

  function cleanBoard(b) {
    if (!b || !Array.isArray(b.strokes)) return null;
    const out = [];
    b.strokes.slice(0, 400).forEach(st => {
      if (!st || !Array.isArray(st.p)) return;
      let pts = st.p.slice(0, 6000).map(Number).filter(Number.isFinite);
      if (pts.length < 2) return;
      if (pts.length % 2) pts = pts.slice(0, -1);
      out.push({
        c: /^#[0-9a-f]{6}$/i.test(st.c) ? st.c : '#000000',
        w: Math.min(80, Math.max(1, Number(st.w) || 6)),
        p: pts
      });
    });
    return { id: String(b.id || ''), strokes: out };
  }

  function receiveBoardPart(m) {
    if (!Number.isInteger(m.n) || m.n < 1 || m.n > 100 || !Number.isInteger(m.i) || m.i < 0 || m.i >= m.n || typeof m.d !== 'string') return;
    if (!boardAsm || boardAsm.id !== m.id) boardAsm = { id: m.id, n: m.n, parts: [], got: 0 };
    if (boardAsm.parts[m.i] !== undefined) return;
    boardAsm.parts[m.i] = m.d;
    boardAsm.got++;
    if (boardAsm.got === boardAsm.n) {
      let parsed = null;
      try { parsed = cleanBoard(JSON.parse(boardAsm.parts.join(''))); } catch (e) { /* ignore */ }
      boardAsm = null;
      if (parsed) { boardData = parsed; boardChanged(true); }
    }
  }

  function boardChanged(open) {
    if (net.role !== 'client') return;
    if (boardData) { if (open) openBoardView(); }
    else closeBoardView();
    updateBoardBtn();
  }
  function openBoardView() {
    const c = $('#boardCanvas');
    drawStrokes(c.getContext('2d'), boardData.strokes, c.width, c.height);
    $('#boardModal').classList.remove('hidden');
    updateBoardBtn();
  }
  function closeBoardView() { $('#boardModal').classList.add('hidden'); updateBoardBtn(); }
  function updateBoardBtn() {
    const show = net.role === 'client' && !!boardData && $('#boardModal').classList.contains('hidden') && !!S && S.phase !== 'lobby';
    $('#showBoardBtn').classList.toggle('hidden', !show);
  }

  function onClientData(msg) {
    if (!msg || typeof msg !== 'object') return;
    lastHostMsg = Date.now();
    if (msg.t === 'hb') return;
    if (msg.t === 'board') { boardData = msg.board ? cleanBoard(msg.board) : null; boardAsm = null; boardChanged(true); return; }
    if (msg.t === 'boardpart') { receiveBoardPart(msg); return; }
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

  function actAnswer(qid, choice) {
    if (net.role === 'host') hostAnswer('host', { qid, choice });
    else if (net.hostConn && net.hostConn.open) net.hostConn.send({ t: 'answer', qid, choice });
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
      qc.textContent = S.qCount + ' question' + (S.qCount === 1 ? '' : 's') + ' ready.' +
        (S.qSkipped ? ' ' + S.qSkipped + ' skipped: they need a wrong answer (open Teacher Mode).' : '') +
        (S.qCount < 20 ? ' Add more in Teacher Mode (about 20+ makes the raft winnable).' : '');
      qc.classList.toggle('warn', S.qCount < 20 || S.qSkipped > 0);
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
    renderWbPanel();
    updateBoardBtn();
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
  let qView = { id: null, choice: null, submitted: false, revealStarted: false };
  const resetQView = () => { qView = { id: null, choice: null, submitted: false, revealStarted: false }; };

  function buildChoices() {
    const box = $('#qChoices');
    box.replaceChildren();
    S.question.choices.forEach((txt, i) => {
      const b = el('button', 'choice');
      b.type = 'button';
      b.dataset.i = i;
      b.append(el('span', 'letter', LETTERS[i]), el('span', 'text', txt), el('span', 'mark'), el('span', 'picks'));
      b.addEventListener('click', () => selectChoice(i));
      box.append(b);
    });
  }

  function canAnswer() {
    if (!S || S.phase !== 'question' || !S.question) return false;
    const me = myPid();
    return S.players.some(p => p.pid === me) && !S.answered.includes(me) && !qView.submitted;
  }

  function selectChoice(i) {
    if (!canAnswer()) return;
    qView.choice = i;
    renderQuestion();
  }

  function renderQuestion() {
    const modal = $('#qModal');
    const active = (S.phase === 'question' || S.phase === 'reveal') && S.question;
    if (!active) { modal.classList.add('hidden'); resetQView(); return; }
    modal.classList.remove('hidden');

    const me = myPid();
    const isHost = net.role === 'host';
    const imPlayer = S.players.some(p => p.pid === me);
    const isQ = S.phase === 'question';
    const rev = S.phase === 'reveal' ? S.reveal : null;

    if (qView.id !== S.question.id) {
      resetQView();
      qView.id = S.question.id;
      buildChoices();
      if (isHost) wbReset();     // fresh whiteboard for each new question
    }
    const locked = S.answered.includes(me) || qView.submitted;
    const chosen = S.mine ? S.mine.choice : qView.choice;
    const interactive = isQ && imPlayer && !locked;

    // Where did we land?
    const L = S.landed;
    const landed = $('#qLanded');
    if (L) {
      if (L.gained) { landed.textContent = L.name + ' found ' + ITEMS[L.type].label + ' ' + ITEMS[L.type].emoji + ' and added it to the raft!'; landed.className = 'q-landed gain'; }
      else if (ITEMS[L.type]) { landed.textContent = L.name + ' landed on ' + ITEMS[L.type].label + ', but the raft is already full.'; landed.className = 'q-landed'; }
      else { landed.textContent = L.name + ' landed on ' + (L.type === 'start' ? 'the start beach.' : 'empty sand.'); landed.className = 'q-landed'; }
    }
    const full = S.raft.length >= S.target;
    $('#qMeta').textContent = (full ? 'Last question: answer to launch the raft! ' : '') +
      'Question ' + S.question.num + ' · ' + S.deckLeft + ' more after this one';
    $('#qText').textContent = S.question.text;

    // Choices. Students only ever see their own pick. The host also sees who picked what.
    const correctIdx = rev ? rev.correctIdx : (isQ ? S_extra.correctIdx : undefined);
    const picks = isHost ? (S_extra.picks || {}) : {};
    $$('#qChoices .choice').forEach((btn, i) => {
      btn.disabled = !interactive;
      btn.classList.toggle('selected', chosen === i && !rev);
      btn.classList.toggle('correct', correctIdx === i);
      const wrongPick = !!rev && !!S.mine && S.mine.choice === i && !S.mine.correct;
      btn.classList.toggle('wrongpick', wrongPick);
      btn.classList.toggle('dim', !!rev && !isHost && correctIdx !== i && !wrongPick);
      btn.querySelector('.mark').textContent = correctIdx === i ? '✓' : (wrongPick ? '✗' : '');
      const pk = btn.querySelector('.picks');
      pk.replaceChildren();
      S.players.filter(p => picks[p.pid] === i).forEach(p => {
        const chip = el('span', 'pickchip');
        const d = el('span', 'dot', initial(p.name));
        d.style.background = p.color;
        chip.append(d, document.createTextNode(p.name));
        pk.append(chip);
      });
    });

    $('#qAnswerArea').classList.toggle('hidden', !interactive);
    $('#qSubmit').disabled = chosen == null;

    const waitEl = $('#qWait');
    const waiting = S.players.filter(p => p.connected && !S.answered.includes(p.pid)).length;
    if (isQ && imPlayer && locked) {
      waitEl.textContent = waiting > 0 ? 'Answer locked in! Waiting for ' + waiting + ' more…' : 'Answer locked in!';
      waitEl.classList.remove('hidden');
    } else if (isQ && !imPlayer) {
      waitEl.textContent = 'Waiting for ' + waiting + ' player' + (waiting === 1 ? '' : 's') + ' to answer…';
      waitEl.classList.remove('hidden');
    } else waitEl.classList.add('hidden');

    const hn = $('#qHostAnswer');
    if (isHost) {
      hn.textContent = imPlayer ? 'Only you can see who picked each answer.' : 'Only you can see the correct answer and who picked each answer.';
      hn.classList.remove('hidden');
    } else hn.classList.add('hidden');

    // Who has answered (names only, never what they picked)
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
    $('#qReveal').classList.toggle('hidden', !rev);
    if (rev) {
      const verdict = $('#qVerdict');
      if (S.mine) {
        verdict.textContent = S.mine.correct ? 'You got it!' : 'Not quite, nice try!';
        verdict.className = 'q-verdict ' + (S.mine.correct ? 'good' : 'meh');
      } else if (imPlayer) {
        verdict.textContent = 'No answer this time.';
        verdict.className = 'q-verdict meh';
      } else {
        verdict.textContent = rev.total ? rev.right + ' of ' + rev.total + ' answered correctly' : 'No answers';
        verdict.className = 'q-verdict meh';
      }
      $('#qCorrect').textContent = 'Correct answer: ' + LETTERS[rev.correctIdx] + '. ' + S.question.choices[rev.correctIdx];
      $('#qTeam').textContent = imPlayer && rev.total ? 'Crew: ' + rev.right + ' of ' + rev.total + ' got it.' : '';

      const auto = S.autoContinue && !S.paused;
      const cd = $('#qCountdown');
      cd.classList.toggle('hidden', !auto);
      if (auto && !qView.revealStarted) {
        cd.style.setProperty('--reveal-ms', REVEAL_MS + 'ms');
        cd.classList.remove('run');
        void cd.offsetWidth;
        cd.classList.add('run');
      }
      qView.revealStarted = true;
      $('#qNextNote').textContent = S.paused
        ? (isHost ? 'Paused while you use the whiteboard. Press “Next turn” when you are ready.' : 'Your teacher is helping everyone understand. Hang tight!')
        : S.autoContinue ? 'The next turn starts in a moment.'
          : (isHost ? 'Press “Next turn” when you are ready.' : 'Waiting for the host to start the next turn…');
    }

    $('#qSkip').classList.toggle('hidden', !(isHost && isQ));
    $('#qContinue').classList.toggle('hidden', !(isHost && !!rev));
    $('#qWhiteboard').classList.toggle('hidden', !isHost);
  }

  function submitAnswer() {
    if (!canAnswer() || qView.choice == null) return;
    qView.submitted = true;
    actAnswer(S.question.id, qView.choice);
    renderQuestion();
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
  let pinPurpose = 'teacher';   // 'teacher' (open question editor) or 'host' (start a room)
  let pendingHostName = '';
  let pinLockedUntil = 0;
  let editingId = null;

  function openPin(purpose = 'teacher', hostName = '') {
    if ($('#teacherModal').classList.contains('hidden') === false) return;
    if (!$('#pinModal').classList.contains('hidden')) return;
    pinPurpose = purpose;
    pendingHostName = hostName;
    $('#pinTitle').textContent = purpose === 'host' ? 'Teacher PIN needed to host' : 'Teacher mode';
    const wait = Math.ceil((pinLockedUntil - Date.now()) / 1000);
    $('#pinMsg').textContent = wait > 0 ? 'Too many tries. Wait ' + wait + ' seconds.' : '';
    $('#pinMsg').classList.toggle('error', wait > 0);
    $('#pinInput').value = '';
    $('#pinModal').classList.remove('hidden');
    setTimeout(() => $('#pinInput').focus(), 30);
  }
  function closePin() { $('#pinModal').classList.add('hidden'); $('#pinInput').value = ''; pinPurpose = 'teacher'; pendingHostName = ''; }

  function submitPin() {
    const now = Date.now();
    if (now < pinLockedUntil) {
      $('#pinMsg').textContent = 'Too many tries. Wait ' + Math.ceil((pinLockedUntil - now) / 1000) + ' seconds.';
      $('#pinMsg').classList.add('error');
      return;
    }
    if ($('#pinInput').value.trim() === TEACHER_PIN) {
      pinFails = 0;
      const purpose = pinPurpose, name = pendingHostName;
      closePin();
      if (purpose === 'host') startHosting(name);
      else openTeacher();
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
    if (net.role === 'host' && S && S.phase === 'lobby') { S.qCount = playable().length; S.qSkipped = questions.length - S.qCount; renderLobby(); }
  }

  function renderTeacher() {
    const ready = playable().length;
    const skipped = questions.length - ready;
    const cnt = $('#tCount');
    cnt.textContent = questions.length + ' question' + (questions.length === 1 ? '' : 's') + ' saved.' +
      (skipped ? ' ' + skipped + ' still need a wrong answer and will be skipped.' : '') +
      (ready < 20 ? ' Tip: players need about 16 turns on average to fill the raft, so 20 to 30 questions makes a fair game.' : '');
    cnt.classList.toggle('warn', ready < 20 || skipped > 0);

    const list = $('#tList');
    list.replaceChildren();
    if (!questions.length) { list.append(el('li', 't-empty', 'No questions yet. Add one above.')); return; }

    questions.forEach(q => {
      const li = el('li', 'trow');
      if (editingId === q.id) {
        li.classList.add('editing');
        const mk = (val, label, cls) => {
          const i = el('input', cls); i.type = 'text'; i.value = val; i.maxLength = 200; i.setAttribute('aria-label', label); return i;
        };
        const qi = mk(q.q, 'Edit question');
        const ai = mk(q.a, 'Edit correct answer', 't-good');
        const wi = [0, 1, 2].map(k => mk(q.wrong[k] || '', 'Edit wrong answer ' + (k + 1)));
        const btns = el('div', 'tbtns');
        const save = el('button', 'btn small palm', 'Save'); save.type = 'button';
        const cancel = el('button', 'btn small ghost', 'Cancel'); cancel.type = 'button';
        const doSave = () => {
          const res = buildQuestion(qi.value, ai.value, wi.map(x => x.value), q.id);
          if (res.error) { toast(res.error); return; }
          Object.assign(q, res.q);
          saveQuestions(); editingId = null; renderTeacher();
        };
        save.addEventListener('click', doSave);
        cancel.addEventListener('click', () => { editingId = null; renderTeacher(); });
        [qi, ai].concat(wi).forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } }));
        btns.append(save, cancel);
        li.append(qi, ai, wi[0], wi[1], wi[2], btns);
        setTimeout(() => qi.focus(), 20);
      } else {
        const main = el('div', 'tmain');
        main.append(el('div', 'tq', q.q));
        const opts = el('div', 'topts');
        opts.append(el('span', 'tchip good', '✓ ' + q.a));
        q.wrong.forEach(w => opts.append(el('span', 'tchip bad', w)));
        if (!q.wrong.length) opts.append(el('span', 'tchip warn', 'Needs at least 1 wrong answer'));
        main.append(opts);

        const edit = el('button', 'btn small ghost', 'Edit'); edit.type = 'button';
        const del = el('button', 'btn small ghost danger', 'Delete'); del.type = 'button';
        edit.addEventListener('click', () => { editingId = q.id; renderTeacher(); });
        del.addEventListener('click', () => {
          if (!window.confirm('Delete this question?')) return;
          questions = questions.filter(x => x.id !== q.id);
          saveQuestions(); renderTeacher();
        });
        const btns = el('div', 'tbtns'); btns.append(edit, del);
        li.append(main, btns);
      }
      list.append(li);
    });
  }

  // Returns an error message, or null when the question was added.
  function addQuestion(qText, aText, wrongs) {
    const res = buildQuestion(qText, aText, wrongs);
    if (res.error) return res.error;
    questions.push(res.q);
    saveQuestions();
    return null;
  }

  function bulkAdd() {
    const ta = $('#tBulk');
    let added = 0, skipped = 0;
    ta.value.split(/\r?\n/).forEach(line => {
      if (!line.trim()) return;
      let q, a, wrongs;
      if (line.includes('\t')) {
        const c = line.split('\t');
        q = c[0]; a = c[1]; wrongs = c.slice(2);
      } else if (line.includes('=>')) {
        const parts = line.split('=>');
        q = parts[0];
        const answers = parts.slice(1).join('=>').split('|');
        a = answers[0]; wrongs = answers.slice(1);
      } else { skipped++; return; }
      if (addQuestion(q, a || '', wrongs || [])) skipped++; else added++;
    });
    ta.value = '';
    renderTeacher();
    toast(added + ' added' + (skipped ? ', ' + skipped + ' line' + (skipped === 1 ? '' : 's') + ' skipped (each needs a question, a correct answer, and at least one wrong answer)' : '') + '.');
  }

  function exportQuestions() {
    const data = JSON.stringify(questions.map(({ q, a, wrong }) => ({ q, a, wrong })), null, 2);
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
          if (typeof q !== 'string' || typeof a !== 'string') return;
          const wrong = Array.isArray(item.wrong) ? item.wrong : [];
          const res = buildQuestion(q, a, wrong);
          if (res.q) { questions.push(res.q); added++; }
          else if (q.trim() && a.trim()) { questions.push({ id: uid(), q: cleanText(q, 200), a: cleanText(a, 80), wrong: [] }); added++; }
        });
        saveQuestions();
        renderTeacher();
        toast(added + ' question' + (added === 1 ? '' : 's') + ' imported.');
      } catch (e) { toast('That file could not be read. Use a file exported from this game.'); }
    };
    reader.readAsText(file);
  }

  /* ---------------------------------------------------------
     WHITEBOARD (teacher draws; strokes are sent to every student)
     Drawing is stored as vector strokes in a 1200x720 space, so it stays
     crisp on any screen and is tiny to send.
     --------------------------------------------------------- */
  const wb = { strokes: [], color: '#1d3948', width: 6, erase: false, cur: null };

  function drawStroke(ctx, st) {
    const p = st.p;
    ctx.strokeStyle = st.c; ctx.fillStyle = st.c; ctx.lineWidth = st.w;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (p.length < 4) { ctx.beginPath(); ctx.arc(p[0], p[1], st.w / 2, 0, Math.PI * 2); ctx.fill(); return; }
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length - 2; i += 2) {
      ctx.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
    }
    ctx.lineTo(p[p.length - 2], p[p.length - 1]);
    ctx.stroke();
  }
  function drawStrokes(ctx, strokes, w, h) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    strokes.forEach(st => drawStroke(ctx, st));
  }

  function wbRedraw() { const c = $('#wbCanvas'); drawStrokes(c.getContext('2d'), wb.strokes, c.width, c.height); }
  function wbReset() { wb.strokes = []; wb.cur = null; if (!$('#wbModal').classList.contains('hidden')) wbRedraw(); }
  function wbSyncTools() {
    $$('#wbColors .wb-swatch').forEach(b => b.classList.toggle('active', !wb.erase && b.dataset.color === wb.color));
    $$('#wbSizes .wb-size').forEach(b => b.classList.toggle('active', Number(b.dataset.w) === wb.width));
    $('#wbEraser').classList.toggle('active', wb.erase);
    $('#wbEraser').setAttribute('aria-pressed', String(wb.erase));
  }

  function openWhiteboard() {
    if (net.role !== 'host' || !S || S.phase === 'lobby') return;
    hostPause();
    $('#wbModal').classList.remove('hidden');
    wbRedraw();
    renderWbPanel();
  }
  function closeWb() { $('#wbModal').classList.add('hidden'); }

  // Side panel of the whiteboard: the question and who picked what (host only).
  function renderWbPanel() {
    if (net.role !== 'host' || $('#wbModal').classList.contains('hidden') || !S) return;
    const q = $('#wbQ'), ul = $('#wbPicks');
    ul.replaceChildren();
    $('#wbHide').classList.toggle('hidden', !S.boardShared);
    $('#wbShow').textContent = S.boardShared ? 'Update what the class sees' : 'Show to class';
    if (!S.question || !(S.phase === 'question' || S.phase === 'reveal')) { q.textContent = 'No question on screen right now.'; return; }
    q.textContent = S.question.text;
    const picks = S_extra.picks || {};
    const correctIdx = S.phase === 'reveal' && S.reveal ? S.reveal.correctIdx : S_extra.correctIdx;
    S.question.choices.forEach((txt, i) => {
      const li = el('li', correctIdx === i ? 'good' : '');
      li.append(el('span', '', LETTERS[i] + '. ' + txt + (correctIdx === i ? ' ✓' : '')));
      const who = S.players.filter(p => picks[p.pid] === i).map(p => p.name);
      li.append(el('div', 'who', who.length ? who.join(', ') : 'no one yet'));
      ul.append(li);
    });
  }

  function initWhiteboard() {
    const c = $('#wbCanvas');
    const pt = e => {
      const r = c.getBoundingClientRect();
      return [Math.round((e.clientX - r.left) * c.width / r.width), Math.round((e.clientY - r.top) * c.height / r.height)];
    };
    c.addEventListener('pointerdown', e => {
      if (e.button > 0) return;
      e.preventDefault();
      if (wb.strokes.length >= 300) { toast('That is a lot of strokes. Undo or clear to keep drawing.'); return; }
      try { c.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      wb.cur = { c: wb.erase ? '#ffffff' : wb.color, w: wb.erase ? wb.width * 3 : wb.width, p: pt(e) };
      wb.strokes.push(wb.cur);
      wbRedraw();
    });
    c.addEventListener('pointermove', e => {
      if (!wb.cur) return;
      const p = wb.cur.p, n = pt(e), lx = p[p.length - 2], ly = p[p.length - 1];
      if (Math.abs(n[0] - lx) + Math.abs(n[1] - ly) < 3 || p.length > 6000) return;
      const ctx = c.getContext('2d');
      ctx.strokeStyle = wb.cur.c; ctx.lineWidth = wb.cur.w; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(n[0], n[1]); ctx.stroke();
      p.push(n[0], n[1]);
    });
    const end = () => { if (wb.cur) { wb.cur = null; wbRedraw(); } };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);

    $$('#wbColors .wb-swatch').forEach(b => b.addEventListener('click', () => { wb.color = b.dataset.color; wb.erase = false; wbSyncTools(); }));
    $$('#wbSizes .wb-size').forEach(b => b.addEventListener('click', () => { wb.width = Number(b.dataset.w); wbSyncTools(); }));
    $('#wbEraser').addEventListener('click', () => { wb.erase = !wb.erase; wbSyncTools(); });
    $('#wbUndo').addEventListener('click', () => { wb.strokes.pop(); wbRedraw(); });
    $('#wbClear').addEventListener('click', () => { wb.strokes = []; wbRedraw(); });
    $('#wbShow').addEventListener('click', () => {
      const r = hostShareBoard(wb.strokes.map(st => ({ c: st.c, w: st.w, p: st.p.slice() })));
      if (r === 'empty') toast('Draw something first.');
      else if (r === 'toolarge') toast('That drawing is too detailed to send. Undo or clear some strokes.');
      else toast('Shown to the class.');
    });
    $('#wbHide').addEventListener('click', () => { hostHideBoard(); toast('Hidden from the class.'); });
    $('#wbClose').addEventListener('click', closeWb);
    wbSyncTools();
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

    $('#hostBtn').addEventListener('click', () => { const n = readName(); if (n) openPin('host', n); });
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
    document.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (!canAnswer() || $('#qModal').classList.contains('hidden')) return;
      if (!$('#wbModal').classList.contains('hidden') || !$('#boardModal').classList.contains('hidden')) return;
      const k = String(e.key).toLowerCase();
      const idx = k.length === 1 ? Math.max('abcd'.indexOf(k), '1234'.indexOf(k)) : -1;
      if (idx >= 0 && idx < S.question.choices.length) selectChoice(idx);
      else if (e.key === 'Enter' && tag !== 'BUTTON' && qView.choice != null) submitAnswer();
    });
    $('#qWhiteboard').addEventListener('click', openWhiteboard);
    $('#hcWhiteboard').addEventListener('click', openWhiteboard);
    $('#boardClose').addEventListener('click', closeBoardView);
    $('#showBoardBtn').addEventListener('click', () => { if (boardData) openBoardView(); });
    initWhiteboard();
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
        else if (!$('#wbModal').classList.contains('hidden')) closeWb();
        else if (!$('#boardModal').classList.contains('hidden')) closeBoardView();
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
      const err = addQuestion($('#tNewQ').value, $('#tNewA').value, [$('#tNewW1').value, $('#tNewW2').value, $('#tNewW3').value]);
      if (err) { toast(err); return; }
      ['#tNewQ', '#tNewA', '#tNewW1', '#tNewW2', '#tNewW3'].forEach(sel => { $(sel).value = ''; });
      renderTeacher();
      $('#tNewQ').focus();
    });
    $('#tBulkBtn').addEventListener('click', bulkAdd);
    $('#tExport').addEventListener('click', exportQuestions);
    $('#tImport').addEventListener('change', e => { importQuestions(e.target.files[0]); e.target.value = ''; });
    $('#tSamples').addEventListener('click', () => {
      if (!window.confirm('Replace all of your questions with the sample questions?')) return;
      questions = sampleQuestions();
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
