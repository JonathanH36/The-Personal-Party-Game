// ============================================================
// Truth Comes Out — Firebase-backed multiplayer prototype
// Every browser window with the room code is a genuinely
// separate player. State lives at /lobbies/{ROOM_CODE} in
// Realtime Database and is mirrored into the local DB object
// by a live onValue listener.
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import { getDatabase, ref, set, onValue, runTransaction } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-database.js";

// Paste the config from your new Firebase project here.
const firebaseConfig = {
  apiKey:            "AIzaSyCUTblha-C25gHX0JbTLRm696KbJ9HHXE4",
  authDomain:        "the-personal-party-game.firebaseapp.com",
  databaseURL:       "https://the-personal-party-game-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "the-personal-party-game",
  storageBucket:     "the-personal-party-game.firebasestorage.app",
  messagingSenderId: "655989726158",
  appId:             "1:655989726158:web:f38da417d45cb9befde99f"
};

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const rtdb = getDatabase(fbApp);
const _authReady = new Promise((resolve) => {
  const unsub = onAuthStateChanged(auth, (user) => { if (user) { unsub(); resolve(user); } });
  signInAnonymously(auth).catch((err) => console.error('Firebase auth error:', err));
});

const CONTENT = JSON.parse(document.getElementById('content-data').textContent);
const ROUND_TYPES = ['truthComesOut', 'storyRound', 'splitTheRoom'];
const FIELD_SEQUENCE = [
  { key: 'maleName', prompt: "A man's name" },
  { key: 'femaleName', prompt: "A woman's name" },
  { key: 'whereMet', prompt: 'Where they met' },
  { key: 'heSaid', prompt: 'What he said to her' },
  { key: 'sheSaid', prompt: 'What she said to him' },
  { key: 'tenYears', prompt: 'Where they will be in 10 years' }
];

function uid(prefix) { return prefix + '_' + Math.random().toString(36).slice(2, 9); }
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function sample(arr, n) { return shuffle(arr).slice(0, n); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ---------------- Store ----------------
// ROOM_CODE identifies which lobby this browser is connected to.
// viewingAs is THIS browser's own player id — fixed once joined,
// no more switching between players from one tab.
let ROOM_CODE = null;
let DB = null;
let viewingAs = null;
let joined = false;

const ROOM_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function generateRoomCode() { return Array.from({ length: 4 }, () => ROOM_LETTERS[Math.floor(Math.random() * ROOM_LETTERS.length)]).join(''); }

function freshDB() {
  return {
    meta: { hostId: null, is18Plus: false, status: 'lobby' },
    players: {},          // id -> { name, joinedAt }
    scoreboard: {},        // id -> number
    session: { roundOrder: [], currentRoundIndex: -1, currentRound: null },
    roundState: null
  };
}

// Firebase drops empty objects entirely, so paths that were emptied
// (e.g. every player left) come back as undefined. Patch them back
// to safe defaults after every snapshot.
function normalizeDB() {
  if (!DB) return;
  DB.meta = DB.meta || { hostId: null, is18Plus: false, status: 'lobby' };
  DB.players = DB.players || {};
  DB.scoreboard = DB.scoreboard || {};
  DB.session = DB.session || { roundOrder: [], currentRoundIndex: -1, currentRound: null };
  normalizeRoundState();
}

// Firebase drops empty objects/arrays entirely rather than storing them as
// {} or [], so any collection that starts empty (nobody's answered/voted
// yet) comes back as `undefined` on every OTHER client's snapshot, not {}.
// Every round keeps at least one such collection, so this has to run for
// whichever round type is currently active, every time a snapshot lands.
function normalizeRoundState() {
  const rs = DB.roundState;
  if (!rs) return;
  if (rs.type === 'truthComesOut') {
    rs.pendingAnswers = rs.pendingAnswers || {};
    rs.answers = rs.answers || {};
    rs.votes = rs.votes || {};
    rs.usedQuestionIds = rs.usedQuestionIds || [];
    rs.shuffledOrder = rs.shuffledOrder || [];
  } else if (rs.type === 'storyRound') {
    rs.pendingFieldAnswers = rs.pendingFieldAnswers || {};
    rs.readerAssignment = rs.readerAssignment || {};
    rs.votes = rs.votes || {};
  } else if (rs.type === 'splitTheRoom') {
    rs.votes = rs.votes || {};
    rs.usedStandard = rs.usedStandard || [];
    rs.usedH2H = rs.usedH2H || [];
  }
}

async function commit() {
  // Full-object overwrite. Only ever safe for the very first write to a
  // brand new room (nobody else can be writing to it yet). Everything
  // that happens once players are in a shared round goes through
  // transactionalCommit below instead.
  render();
  if (!ROOM_CODE) return;
  try { await set(ref(rtdb, 'lobbies/' + ROOM_CODE), DB); }
  catch (e) { console.error('Firebase write failed:', e); }
}

// Multiple players write to the same lobby object at once (everyone
// submitting an answer or a vote within the same second or two). A plain
// set() overwrites the whole object with whatever THIS client's local
// copy looked like, silently discarding anyone else's write that landed
// in between — which is exactly what caused the "last player's submit
// does nothing" bug. A transaction fetches the true current server
// value fresh, lets mutatorFn mutate THAT, and Firebase retries
// automatically if another write lands in the meantime, so nobody's
// contribution gets lost.
async function transactionalCommit(mutatorFn) {
  if (!ROOM_CODE) return;
  const lobbyRef = ref(rtdb, 'lobbies/' + ROOM_CODE);
  try {
    const result = await runTransaction(lobbyRef, (currentDB) => {
      if (currentDB === null) return currentDB;   // room not created yet server-side, abort quietly
      const savedDB = DB;
      DB = currentDB;
      normalizeDB();
      mutatorFn();
      const out = DB;
      DB = savedDB;
      return out;
    });
    // Don't wait on the separate onValue round-trip to find out our own
    // write succeeded — paint the confirmed result immediately. On a slow
    // connection, relying only on onValue left a gap where the submitting
    // player's own screen looked frozen even though the write had gone
    // through fine.
    if (result && result.committed && result.snapshot) {
      DB = result.snapshot.val() || DB;
      normalizeDB();
      render();
    }
  } catch (e) { console.error('Firebase transaction failed:', e); }
}

function playerIds() { return DB ? Object.keys(DB.players) : []; }
function playerName(id) { return DB && DB.players[id] ? DB.players[id].name : '—'; }
function isHost(id) { return DB && DB.meta.hostId === id; }
function addScore(id, delta) { DB.scoreboard[id] = (DB.scoreboard[id] || 0) + delta; }

function identityKey() { return 'tco_identity_' + ROOM_CODE; }

async function enterRoom(code, isNewRoom) {
  await _authReady;
  ROOM_CODE = code;
  localStorage.setItem('tco_last_room', code);
  const roomRef = ref(rtdb, 'lobbies/' + code);
  if (isNewRoom) DB = freshDB();
  onValue(roomRef, (snapshot) => {
    const val = snapshot.val();
    DB = val || freshDB();
    normalizeDB();
    const savedId = localStorage.getItem(identityKey());
    if (savedId && DB.players[savedId]) { viewingAs = savedId; joined = true; }
    render();
  });
  if (isNewRoom) await commit();
}

function leaveRoom() {
  ROOM_CODE = null; DB = null; viewingAs = null; joined = false;
  render();
}

// ---------------- Lobby ----------------
async function joinAsNewPlayer(name) {
  name = name.trim();
  if (!name || !DB) return;
  const id = uid('player');
  viewingAs = id;
  joined = true;
  localStorage.setItem(identityKey(), id);
  await transactionalCommit(() => {
    DB.players[id] = { name, joinedAt: Date.now() };
    DB.scoreboard[id] = 0;
    if (!DB.meta.hostId) DB.meta.hostId = id;
  });
}
function toggle18Plus() { transactionalCommit(() => { DB.meta.is18Plus = !DB.meta.is18Plus; }); }

function beginSession() {
  const n = playerIds().length;
  if (n < 4 || n > 12) return;
  transactionalCommit(() => {
    DB.meta.status = 'in_round';
    DB.session.roundOrder = shuffle(ROUND_TYPES);   // engine-randomised, not host-visible ahead of time
    DB.session.currentRoundIndex = -1;
    advanceToNextRound();
  });
}

function advanceToNextRound() {
  DB.session.currentRoundIndex++;
  if (DB.session.currentRoundIndex >= DB.session.roundOrder.length) {
    DB.meta.status = 'session_end';
    DB.roundState = null;
    return;
  }
  const type = DB.session.roundOrder[DB.session.currentRoundIndex];
  DB.session.currentRound = type;
  if (type === 'truthComesOut') startTruthComesOut();
  else if (type === 'storyRound') startStoryRound();
  else if (type === 'splitTheRoom') startSplitTheRoom();
}

// ============================================================
// ROUND 1 — Truth Comes Out
// ============================================================
function truthTotalTurns() {
  const n = playerIds().length;
  return (n <= 5) ? n : 6;
}
function startTruthComesOut() {
  const n = playerIds().length;
  DB.roundState = {
    type: 'truthComesOut',
    totalTurns: truthTotalTurns(),
    turnIndex: 0,
    subjectOrder: sample(playerIds(), truthTotalTurns()),
    usedQuestionIds: [],
    phase: 'writing',
    subjectId: null,
    questionText: '',
    pendingAnswers: {},
    answers: {},
    shuffledOrder: [],
    votes: {}
  };
  startTruthTurn();
}
function truthPickQuestion() {
  const bank = DB.meta.is18Plus ? CONTENT.truthComesOut.standard.concat(CONTENT.truthComesOut.adult) : CONTENT.truthComesOut.standard;
  const rs = DB.roundState;
  const remaining = bank.filter(q => !rs.usedQuestionIds.includes(q));
  const chosen = remaining.length ? pick(remaining) : pick(bank);
  rs.usedQuestionIds.push(chosen);
  return chosen;
}
function startTruthTurn() {
  const rs = DB.roundState;
  rs.subjectId = rs.subjectOrder[rs.turnIndex];
  rs.questionText = truthPickQuestion();
  rs.phase = 'writing';
  rs.pendingAnswers = {};
  rs.answers = {};
  rs.shuffledOrder = [];
  rs.votes = {};
}
function truthSubmitAnswer(playerId, text) {
  if (!text.trim()) return;
  transactionalCommit(() => {
    const rs = DB.roundState;
    if (rs.phase !== 'writing') return;   // phase already moved on — a late click, ignore
    rs.pendingAnswers[playerId] = text.trim();
    if (Object.keys(rs.pendingAnswers).length >= playerIds().length) truthAdvanceToVoting();
  });
}
function truthAdvanceToVoting() {
  const rs = DB.roundState;
  rs.answers = {};
  Object.entries(rs.pendingAnswers).forEach(([pid, text]) => {
    rs.answers[uid('slot')] = { authorId: pid, text };
  });
  rs.pendingAnswers = {};
  rs.shuffledOrder = shuffle(Object.keys(rs.answers));
  rs.phase = 'voting';
}
function truthEligibleVoters() { return playerIds().filter(id => id !== DB.roundState.subjectId); }
function truthSubmitVote(playerId, slotId) {
  transactionalCommit(() => {
    const rs = DB.roundState;
    if (rs.phase !== 'voting') return;   // phase already moved on — a late click, ignore
    rs.votes[playerId] = slotId;
    if (Object.keys(rs.votes).length >= truthEligibleVoters().length) truthReveal();
  });
}
function truthReveal() {
  const rs = DB.roundState;
  rs.phase = 'reveal';
  const correctSlot = Object.entries(rs.answers).find(([id, a]) => a.authorId === rs.subjectId)[0];
  let correctCount = 0;
  let fooledCount = 0;
  Object.entries(rs.votes).forEach(([voterId, slotId]) => {
    if (slotId === correctSlot) { addScore(voterId, 1); correctCount++; }
    else { addScore(rs.subjectId, 0.5); fooledCount++; }
  });
  rs.correctSlot = correctSlot;
  rs.anyoneCorrect = correctCount > 0;
  rs.fooledCount = fooledCount;
}
function truthNext() {
  transactionalCommit(() => {
    const rs = DB.roundState;
    rs.turnIndex++;
    if (rs.turnIndex >= rs.totalTurns) { advanceToNextRound(); return; }
    startTruthTurn();
  });
}

// ============================================================
// ROUND 2 — Story Round
// ============================================================
function startStoryRound() {
  const order = shuffle(playerIds());
  const n = order.length;
  const stories = {};
  order.forEach((pid, i) => { stories['story_' + i] = { ownerId: pid, fields: new Array(FIELD_SEQUENCE.length).fill(null) }; });
  DB.roundState = {
    type: 'storyRound',
    playerOrder: order,
    stories,
    passIndex: 0,
    phase: 'writing',
    pendingFieldAnswers: {},
    readerAssignment: {},
    currentReadIndex: 0,
    votes: {}
  };
}
function storyStoryIndexFor(playerIndex, passIndex, n) { return (playerIndex + passIndex + 1) % n; }
function storySubmitField(playerId, text) {
  if (!text.trim()) return;
  transactionalCommit(() => {
    const rs = DB.roundState;
    if (rs.phase !== 'writing') return;   // phase already moved on — a late click, ignore
    rs.pendingFieldAnswers[playerId] = text.trim();
    if (Object.keys(rs.pendingFieldAnswers).length >= rs.playerOrder.length) storyCommitPass();
  });
}
function storyCommitPass() {
  const rs = DB.roundState;
  const n = rs.playerOrder.length;
  rs.playerOrder.forEach((pid, i) => {
    const storyIdx = storyStoryIndexFor(i, rs.passIndex, n);
    const text = rs.pendingFieldAnswers[pid];
    rs.stories['story_' + storyIdx].fields[rs.passIndex] = { value: text, contributorId: pid };
  });
  rs.pendingFieldAnswers = {};
  rs.passIndex++;
  if (rs.passIndex >= FIELD_SEQUENCE.length) storyEnterReading();
}
function storyEnterReading() {
  const rs = DB.roundState;
  const n = rs.playerOrder.length;
  Object.keys(rs.stories).forEach((key, idx) => {
    rs.readerAssignment[key] = rs.playerOrder[(idx + 1) % n];
  });
  rs.phase = 'reading';
  rs.currentReadIndex = 0;
}
function storyNextRead() {
  transactionalCommit(() => {
    const rs = DB.roundState;
    const keys = Object.keys(rs.stories);
    rs.currentReadIndex++;
    if (rs.currentReadIndex >= keys.length) { rs.phase = 'voting'; }
  });
}
function storySubmitVote(playerId, storyKey) {
  transactionalCommit(() => {
    const rs = DB.roundState;
    if (rs.phase !== 'voting') return;   // phase already moved on — a late click, ignore
    rs.votes[playerId] = storyKey;
    if (Object.keys(rs.votes).length >= rs.playerOrder.length) storyReveal();
  });
}
function storyReveal() {
  const rs = DB.roundState;
  rs.phase = 'reveal';
  const tally = {};
  Object.values(rs.votes).forEach(k => { tally[k] = (tally[k] || 0) + 1; });
  const max = Math.max(...Object.values(tally));
  const winners = Object.keys(tally).filter(k => tally[k] === max);
  rs.tally = tally;
  rs.winners = winners;
  const pointsPerField = winners.length > 1 ? 0.5 : 1;
  winners.forEach(key => {
    rs.stories[key].fields.forEach(f => { if (f) addScore(f.contributorId, pointsPerField); });
  });
}
function storyFinish() { transactionalCommit(() => { advanceToNextRound(); }); }
function storyFieldText(story, index) {
  const f = story.fields[index];
  return f ? f.value : '____';
}
function storyFullText(story) {
  return `${storyFieldText(story, 0)} met ${storyFieldText(story, 1)} ${storyFieldText(story, 2)}. `
    + `He said: "${storyFieldText(story, 3)}" She said: "${storyFieldText(story, 4)}" `
    + `In ten years, they'll be ${storyFieldText(story, 5)}.`;
}

// ============================================================
// ROUND 3 — Split the Room
// ============================================================
function splitTotalInstances() {
  const n = playerIds().length;
  return (n <= 8) ? 10 : 12;
}
function startSplitTheRoom() {
  DB.roundState = {
    type: 'splitTheRoom',
    totalInstances: splitTotalInstances(),
    instanceIndex: 0,
    usedStandard: [],
    usedH2H: [],
    phase: 'voting',
    mode: null,
    current: null,
    votes: {}
  };
  splitStartInstance();
}
function splitEligiblePlayers() {
  return playerIds();
}
function splitStartInstance() {
  const rs = DB.roundState;
  const n = playerIds().length;
  const canH2H = n >= 4 && CONTENT.splitTheRoom.headToHead.length > 0;
  const useH2H = canH2H && Math.random() < 0.3;
  rs.mode = useH2H ? 'headToHead' : 'standard';
  rs.votes = {};
  rs.phase = 'voting';
  if (useH2H) {
    const pool = CONTENT.splitTheRoom.headToHead.filter(t => !rs.usedH2H.includes(t));
    const trait = pool.length ? pick(pool) : pick(CONTENT.splitTheRoom.headToHead);
    rs.usedH2H.push(trait);
    const [pA, pB] = sample(playerIds(), 2);
    rs.current = { traitText: trait, playerA: pA, playerB: pB };
  } else {
    const pool = CONTENT.splitTheRoom.standard.filter(q => !rs.usedStandard.includes(q.optionA + '|' + q.optionB));
    const q = pool.length ? pick(pool) : pick(CONTENT.splitTheRoom.standard);
    rs.usedStandard.push(q.optionA + '|' + q.optionB);
    rs.current = { optionA: q.optionA, optionB: q.optionB, promptSuffix: q.promptSuffix };
  }
}
function splitSubmitVote(playerId, choice) {
  transactionalCommit(() => {
    const rs = DB.roundState;
    if (rs.phase !== 'voting') return;   // phase already moved on — a late click, ignore
    rs.votes[playerId] = choice;
    if (Object.keys(rs.votes).length >= splitEligiblePlayers().length) splitReveal();
  });
}
function splitReveal() {
  const rs = DB.roundState;
  rs.phase = 'reveal';
  const votes = Object.values(rs.votes);
  const aCount = votes.filter(v => v === 'A').length;
  const bCount = votes.filter(v => v === 'B').length;
  rs.tally = { A: aCount, B: bCount };
  if (rs.mode === 'standard') {
    if (aCount === bCount) {
      splitEligiblePlayers().forEach(id => addScore(id, -1));
    } else {
      const majority = aCount > bCount ? 'A' : 'B';
      Object.entries(rs.votes).forEach(([pid, v]) => { if (v === majority) addScore(pid, 1); });
    }
  } else {
    // head-to-head
    Object.entries(rs.votes).forEach(([pid, v]) => { const majority = aCount > bCount ? 'A' : (bCount > aCount ? 'B' : null); if (majority && v === majority) addScore(pid, 1); });
    if (aCount === bCount) {
      addScore(rs.current.playerA, 0.5);
      addScore(rs.current.playerB, 0.5);
    } else {
      const winnerId = aCount > bCount ? rs.current.playerA : rs.current.playerB;
      addScore(winnerId, 1);
    }
  }
}
function splitNext() {
  transactionalCommit(() => {
    const rs = DB.roundState;
    rs.instanceIndex++;
    if (rs.instanceIndex >= rs.totalInstances) { advanceToNextRound(); return; }
    splitStartInstance();
  });
}

// ============================================================
// RENDER
// ============================================================
const appEl = document.getElementById('app');

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'disabled' || k === 'checked' || k === 'readonly' || k === 'required') {
      // Boolean HTML attributes: presence alone means "on", regardless of
      // the string value, so setAttribute(k, false) still disables it.
      if (v) el.setAttribute(k, '');
      else el.removeAttribute(k);
    }
    else el.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach(c => {
    if (c === null || c === undefined) return;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return el;
}

function render() {
  appEl.innerHTML = '';
  if (!ROOM_CODE) { appEl.appendChild(renderRoomGate()); return; }
  appEl.appendChild(renderTopBar());
  const screen = h('div', { class: 'screen' });
  if (!joined) screen.appendChild(renderJoinForm());
  else if (DB.meta.status === 'lobby') screen.appendChild(renderLobby());
  else if (DB.meta.status === 'in_round') screen.appendChild(renderRound());
  else if (DB.meta.status === 'session_end') screen.appendChild(renderSessionEnd());
  appEl.appendChild(screen);
  appEl.appendChild(h('div', { class: 'footer-note' }, `Room ${ROOM_CODE} · synced live over Firebase.`));
}

// ---------------- Room gate (before joining any lobby) ----------------
function renderRoomGate() {
  const wrap = h('div', { class: 'screen' });
  wrap.appendChild(h('div', { class: 'eyebrow' }, 'Truth Comes Out'));
  wrap.appendChild(h('h1', {}, 'Start or join a game'));
  wrap.appendChild(h('div', { class: 'card raised' }, [
    h('div', { style: 'font-weight:700;margin-bottom:6px;' }, 'Host a new game'),
    h('p', { class: 'muted' }, `Creates a fresh 4-letter room code. Share it with everyone else so they can join on their own phone.`),
    h('button', { class: 'primary', onclick: async () => { await enterRoom(generateRoomCode(), true); } }, 'Create game')
  ]));
  const codeInput = h('input', { type: 'text', placeholder: 'e.g. ABCD', maxlength: '4', style: 'text-transform:uppercase;' });
  wrap.appendChild(h('div', { class: 'card raised' }, [
    h('div', { style: 'font-weight:700;margin-bottom:6px;' }, 'Join with a code'),
    h('label', { class: 'field' }, ['Room code', codeInput]),
    h('div', { style: 'height:10px' }),
    h('button', { class: 'secondary', onclick: async () => { const v = codeInput.value.trim().toUpperCase(); if (v.length === 4) await enterRoom(v, false); } }, 'Join game')
  ]));
  const lastRoom = localStorage.getItem('tco_last_room');
  if (lastRoom) {
    wrap.appendChild(h('button', { class: 'ghost', onclick: async () => { await enterRoom(lastRoom, false); } }, `Rejoin your last room (${lastRoom})`));
  }
  return wrap;
}

function renderTopBar() {
  const bar = h('div', { class: 'device-bar' });
  const row = h('div', { class: 'top-bar-lobby' }, [
    h('span', { class: 'code-badge' }, ROOM_CODE),
    h('span', { style: 'font-size:13px;color:var(--text-dim);' }, joined ? `You: ${playerName(viewingAs)}` : 'Not joined yet'),
    h('span', { style: 'cursor:pointer;text-decoration:underline;font-size:12px;color:var(--text-dim);', onclick: leaveRoom }, 'leave room')
  ]);
  bar.appendChild(row);
  return bar;
}

// ---------------- Join form (this browser hasn't picked a name yet) ----------------
function renderJoinForm() {
  const wrap = document.createDocumentFragment();
  wrap.appendChild(h('div', { class: 'eyebrow' }, 'Lobby ' + ROOM_CODE));
  wrap.appendChild(h('h1', {}, 'Enter your name'));
  const n = playerIds().length;
  if (n > 0) {
    wrap.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'eyebrow' }, `${n} joined so far`),
      h('div', { class: 'player-list' }, playerIds().map(id => h('div', { class: 'player-row' }, [h('span', {}, playerName(id)), isHost(id) ? h('span', { class: 'pill' }, 'Host') : null])))
    ]));
  }
  const nameInput = h('input', { type: 'text', placeholder: 'Your name' });
  wrap.appendChild(h('div', { class: 'card raised' }, [
    h('label', { class: 'field' }, ['Name', nameInput]),
    h('div', { style: 'height:10px' }),
    h('button', { class: 'primary', onclick: () => joinAsNewPlayer(nameInput.value) }, 'Join lobby')
  ]));
  return wrap;
}

// ---------------- Lobby screen (already joined, waiting to begin) ----------------
function renderLobby() {
  const wrap = document.createDocumentFragment();
  wrap.appendChild(h('div', { class: 'eyebrow' }, 'Lobby ' + ROOM_CODE));
  wrap.appendChild(h('h1', {}, 'Truth Comes Out'));
  wrap.appendChild(h('p', { class: 'muted' }, `4 to 12 players. Waiting for everyone to join on their own phone.`));

  const n = playerIds().length;
  const list = h('div', { class: 'card' });
  list.appendChild(h('div', { class: 'eyebrow' }, `${n} player${n === 1 ? '' : 's'} joined`));
  const pl = h('div', { class: 'player-list' });
  playerIds().forEach(id => {
    pl.appendChild(h('div', { class: 'player-row' }, [
      h('span', {}, [playerName(id), isHost(id) ? h('span', { class: 'pill', style: 'margin-left:8px;' }, 'Host') : null]),
      id === viewingAs ? h('span', { class: 'muted', style: 'font-size:12px;' }, 'you') : null
    ]));
  });
  list.appendChild(pl);
  wrap.appendChild(list);

  // host controls
  const hostView = viewingAs === DB.meta.hostId;
  const controls = h('div', { class: 'card' });
  controls.appendChild(h('div', { class: 'eyebrow' }, 'Host controls'));
  const toggleRow = h('div', { class: 'toggle-row' }, [
    h('div', {}, [h('strong', {}, '18+ content'), h('div', { class: 'muted' }, 'Off means every question stays standard-tier.')]),
    h('label', { class: 'switch' }, [
      (() => { const i = h('input', { type: 'checkbox' }); i.checked = DB.meta.is18Plus; i.disabled = !hostView; i.addEventListener('change', toggle18Plus); return i; })(),
      h('span', { class: 'track' })
    ])
  ]);
  controls.appendChild(toggleRow);
  wrap.appendChild(controls);

  const canBegin = n >= 4 && n <= 12;
  const beginBtn = h('button', { class: 'primary', onclick: beginSession, disabled: !(canBegin && hostView) }, canBegin ? 'Begin session' : `Need ${n < 4 ? '4 to 12' : '4 to 12 (currently over)'} players`);
  wrap.appendChild(beginBtn);
  if (!hostView) wrap.appendChild(h('p', { class: 'muted' }, `Only the host (${playerName(DB.meta.hostId)}) can toggle 18+ or begin.`));
  return wrap;
}

// ---------------- Round dispatcher ----------------
function renderRound() {
  const type = DB.session.currentRound;
  if (type === 'truthComesOut') return renderTruthComesOut();
  if (type === 'storyRound') return renderStoryRound();
  if (type === 'splitTheRoom') return renderSplitTheRoom();
  return h('div', {}, 'Unknown round');
}

function roundBanner(title, indexLabel) {
  return h('div', { class: 'round-banner' }, [
    h('div', {}, [h('div', { class: 'eyebrow' }, DB.session.currentRound), h('h2', {}, title)]),
    h('div', { class: 'count' }, indexLabel)
  ]);
}
function scoreboardMini() {
  const box = h('div', { class: 'card', style: 'padding:12px;' });
  const list = h('div', { class: 'player-list' });
  playerIds().slice().sort((a, b) => (DB.scoreboard[b] || 0) - (DB.scoreboard[a] || 0)).forEach(id => {
    list.appendChild(h('div', { class: 'player-row' }, [h('span', {}, playerName(id)), h('span', { class: 'score' }, String(DB.scoreboard[id] || 0))]));
  });
  box.appendChild(list);
  return box;
}

// ---------------- Truth Comes Out UI ----------------
function renderTruthComesOut() {
  const rs = DB.roundState;
  const wrap = document.createDocumentFragment();
  wrap.appendChild(roundBanner('Truth Comes Out', `Turn ${rs.turnIndex + 1} / ${rs.totalTurns}`));
  wrap.appendChild(h('div', { class: 'card' }, [
    h('span', { class: 'eyebrow' }, 'Subject'),
    h('div', { style: 'font-weight:700;margin:2px 0 8px;' }, playerName(rs.subjectId)),
    h('div', { class: 'prompt-text' }, rs.questionText)
  ]));

  if (rs.phase === 'writing') {
    if (!viewingAs) return wrap;
    const already = rs.pendingAnswers[viewingAs] !== undefined;
    if (already) {
      wrap.appendChild(waitingBlock(`Answer locked in. Waiting on ${playerIds().length - Object.keys(rs.pendingAnswers).length} more player(s)...`));
    } else if (viewingAs === rs.subjectId) {
      wrap.appendChild(writeBox('Write your real answer, honestly.', (t) => truthSubmitAnswer(viewingAs, t)));
    } else {
      wrap.appendChild(writeBox(`Write your best guess at what ${playerName(rs.subjectId)} would say.`, (t) => truthSubmitAnswer(viewingAs, t)));
    }
  } else if (rs.phase === 'voting') {
    const eligible = truthEligibleVoters();
    if (viewingAs === rs.subjectId) {
      wrap.appendChild(waitingBlock(`Sit tight — everyone else is voting on which answer is really yours.`));
    } else if (rs.votes[viewingAs] !== undefined) {
      wrap.appendChild(waitingBlock(`Vote locked in. Waiting on ${eligible.length - Object.keys(rs.votes).length} more voter(s)...`));
    } else {
      const grid = h('div', { class: 'option-grid' });
      rs.shuffledOrder.forEach(slotId => {
        const a = rs.answers[slotId];
        if (a.authorId === viewingAs) return; // can't vote your own guess
        grid.appendChild(h('div', { class: 'answer-slot', onclick: () => truthSubmitVote(viewingAs, slotId) }, a.text));
      });
      wrap.appendChild(h('p', { class: 'muted' }, 'Tap the one you think is real.'));
      wrap.appendChild(grid);
    }
  } else if (rs.phase === 'reveal') {
    const grid = h('div', { class: 'option-grid' });
    rs.shuffledOrder.forEach(slotId => {
      const a = rs.answers[slotId];
      const votesFor = Object.values(rs.votes).filter(v => v === slotId).length;
      const cls = 'answer-slot' + (slotId === rs.correctSlot ? ' correct' : '');
      grid.appendChild(h('div', { class: cls }, [
        a.text,
        h('div', { class: 'author' }, `Written by ${playerName(a.authorId)}${slotId === rs.correctSlot ? ' — the real answer' : ''} · ${votesFor} vote${votesFor === 1 ? '' : 's'}`)
      ]));
    });
    wrap.appendChild(grid);
    const scoreLines = [];
    if (rs.anyoneCorrect) scoreLines.push(h('div', { class: 'score-flash' }, `+1 to everyone who found ${playerName(rs.subjectId)}'s real answer.`));
    if (rs.fooledCount > 0) scoreLines.push(h('div', { class: 'score-flash' }, `+${rs.fooledCount * 0.5} to ${playerName(rs.subjectId)} — half a point for each of the ${rs.fooledCount} player${rs.fooledCount === 1 ? '' : 's'} fooled.`));
    scoreLines.forEach(l => wrap.appendChild(l));
    wrap.appendChild(h('button', { class: 'primary', onclick: truthNext }, rs.turnIndex + 1 >= rs.totalTurns ? 'Continue to next round' : 'Next turn'));
  }
  wrap.appendChild(scoreboardMini());
  return wrap;
}

function writeBox(label, onSubmit) {
  const box = h('div', { class: 'card raised' });
  box.appendChild(h('label', { class: 'field' }, [label, (() => { const t = h('textarea', {}); t.id = 'write-input'; return t; })()]));
  box.appendChild(h('div', { style: 'height:10px' }));
  box.appendChild(h('button', {
    class: 'primary', onclick: () => { const v = document.getElementById('write-input').value; if (v.trim()) onSubmit(v); }
  }, 'Submit'));
  return box;
}
function waitingBlock(text) {
  return h('div', { class: 'waiting' }, [h('div', { class: 'spinner' }), h('div', {}, text)]);
}

// ---------------- Story Round UI ----------------
function renderStoryRound() {
  const rs = DB.roundState;
  const wrap = document.createDocumentFragment();
  wrap.appendChild(roundBanner('Story Round', rs.phase === 'writing' ? `Field ${rs.passIndex + 1} / ${FIELD_SEQUENCE.length}` : ''));

  if (rs.phase === 'writing') {
    const field = FIELD_SEQUENCE[rs.passIndex];
    const strip = h('div', { class: 'field-strip' });
    FIELD_SEQUENCE.forEach((f, i) => strip.appendChild(h('span', { class: 'field-chip' + (i < rs.passIndex ? ' done' : i === rs.passIndex ? ' current' : '') }, f.key)));
    wrap.appendChild(strip);
    const n = rs.playerOrder.length;
    const myIndex = rs.playerOrder.indexOf(viewingAs);
    const myStory = myIndex >= 0 ? 'story_' + storyStoryIndexFor(myIndex, rs.passIndex, n) : null;
    if (myIndex < 0) return wrap;
    if (rs.pendingFieldAnswers[viewingAs] !== undefined) {
      wrap.appendChild(waitingBlock(`Contribution locked in. Waiting on ${n - Object.keys(rs.pendingFieldAnswers).length} more...`));
    } else {
      wrap.appendChild(writeBox(`${field.prompt} (for a story you can't see the rest of)`, (t) => storySubmitField(viewingAs, t)));
    }
  } else if (rs.phase === 'reading') {
    const keys = Object.keys(rs.stories);
    const key = keys[rs.currentReadIndex];
    const story = rs.stories[key];
    const reader = rs.readerAssignment[key];
    wrap.appendChild(h('div', { class: 'card raised' }, [
      h('span', { class: 'eyebrow' }, `Read aloud by ${playerName(reader)}`),
      h('div', { class: 'story-read', style: 'margin-top:8px;' }, storyFullText(story))
    ]));
    wrap.appendChild(h('p', { class: 'muted' }, `Story ${rs.currentReadIndex + 1} of ${keys.length}. Once it's been read out loud, move on.`));
    wrap.appendChild(h('button', { class: 'primary', onclick: storyNextRead }, rs.currentReadIndex + 1 >= keys.length ? 'All read — start voting' : 'Next story'));
  } else if (rs.phase === 'voting') {
    if (rs.votes[viewingAs] !== undefined) {
      wrap.appendChild(waitingBlock(`Vote locked in. Waiting on ${rs.playerOrder.length - Object.keys(rs.votes).length} more...`));
    } else {
      const grid = h('div', { class: 'option-grid' });
      Object.entries(rs.stories).forEach(([key, story]) => {
        grid.appendChild(h('div', { class: 'answer-slot', onclick: () => storySubmitVote(viewingAs, key) }, [
          h('div', { class: 'author', style: 'margin-bottom:6px;' }, `Read by ${playerName(rs.readerAssignment[key])}`),
          storyFullText(story)
        ]));
      });
      wrap.appendChild(h('p', { class: 'muted' }, 'Vote for the funniest story.'));
      wrap.appendChild(grid);
    }
  } else if (rs.phase === 'reveal') {
    rs.winners.forEach(key => {
      wrap.appendChild(h('div', { class: 'card raised' }, [
        h('span', { class: 'eyebrow' }, `Winner — read by ${playerName(rs.readerAssignment[key])} · ${rs.tally[key]} vote${rs.tally[key] === 1 ? '' : 's'}`),
        h('div', { class: 'story-read', style: 'margin-top:8px;' }, storyFullText(rs.stories[key]))
      ]));
    });
    const pts = rs.winners.length > 1 ? 0.5 : 1;
    const contributors = new Set();
    rs.winners.forEach(key => rs.stories[key].fields.forEach(f => f && contributors.add(f.contributorId)));
    wrap.appendChild(h('div', { class: 'score-flash' }, `+${pts} to each contributor of the winning stor${rs.winners.length > 1 ? 'ies' : 'y'}: ${[...contributors].map(playerName).join(', ')}`));
    wrap.appendChild(h('button', { class: 'primary', onclick: storyFinish }, 'Continue to next round'));
  }
  wrap.appendChild(scoreboardMini());
  return wrap;
}

// ---------------- Split the Room UI ----------------
function renderSplitTheRoom() {
  const rs = DB.roundState;
  const wrap = document.createDocumentFragment();
  wrap.appendChild(roundBanner('Split the Room' + (rs.mode === 'headToHead' ? ' · Head to head' : ''), `Round ${rs.instanceIndex + 1} / ${rs.totalInstances}`));

  const promptCard = h('div', { class: 'card' });
  if (rs.mode === 'standard') {
    promptCard.appendChild(h('div', { class: 'prompt-text' }, `${rs.current.optionA} vs ${rs.current.optionB}, ${rs.current.promptSuffix}`));
  } else {
    promptCard.appendChild(h('div', { class: 'prompt-text' }, `${playerName(rs.current.playerA)} or ${playerName(rs.current.playerB)}: who ${rs.current.traitText.replace(/^Is /, 'is ')}?`));
  }
  wrap.appendChild(promptCard);

  if (rs.phase === 'voting') {
    if (rs.votes[viewingAs] !== undefined) {
      wrap.appendChild(waitingBlock(`Vote locked in. Waiting on ${playerIds().length - Object.keys(rs.votes).length} more...`));
    } else {
      const grid = h('div', { class: 'option-grid' });
      const labelA = rs.mode === 'standard' ? rs.current.optionA : playerName(rs.current.playerA);
      const labelB = rs.mode === 'standard' ? rs.current.optionB : playerName(rs.current.playerB);
      grid.appendChild(h('button', { class: 'option-btn', onclick: () => splitSubmitVote(viewingAs, 'A') }, [h('span', { class: 'tag' }, 'Option A'), labelA]));
      grid.appendChild(h('button', { class: 'option-btn', onclick: () => splitSubmitVote(viewingAs, 'B') }, [h('span', { class: 'tag' }, 'Option B'), labelB]));
      wrap.appendChild(grid);
    }
  } else if (rs.phase === 'reveal') {
    const labelA = rs.mode === 'standard' ? rs.current.optionA : playerName(rs.current.playerA);
    const labelB = rs.mode === 'standard' ? rs.current.optionB : playerName(rs.current.playerB);
    wrap.appendChild(h('div', { class: 'card raised' }, [
      h('div', {}, `${labelA}: ${rs.tally.A}`),
      h('div', {}, `${labelB}: ${rs.tally.B}`)
    ]));
    if (rs.mode === 'standard') {
      if (rs.tally.A === rs.tally.B) {
        wrap.appendChild(h('div', { class: 'score-flash negative' }, `Dead split — everyone loses a point.`));
      } else {
        const majLabel = rs.tally.A > rs.tally.B ? labelA : labelB;
        wrap.appendChild(h('div', { class: 'score-flash' }, `+1 to everyone who backed "${majLabel}".`));
      }
    } else {
      if (rs.tally.A === rs.tally.B) {
        wrap.appendChild(h('div', { class: 'score-flash' }, `Tied — ${playerName(rs.current.playerA)} and ${playerName(rs.current.playerB)} split half a point each.`));
      } else {
        const winnerId = rs.tally.A > rs.tally.B ? rs.current.playerA : rs.current.playerB;
        wrap.appendChild(h('div', { class: 'score-flash' }, `+1 to ${playerName(winnerId)} for winning the majority, plus everyone who backed them.`));
      }
    }
    wrap.appendChild(h('button', { class: 'primary', onclick: splitNext }, rs.instanceIndex + 1 >= rs.totalInstances ? 'Continue to next round' : 'Next prompt'));
  }
  wrap.appendChild(scoreboardMini());
  return wrap;
}

// ---------------- Session end ----------------
function renderSessionEnd() {
  const wrap = document.createDocumentFragment();
  wrap.appendChild(h('div', { class: 'eyebrow' }, 'Session complete'));
  wrap.appendChild(h('h1', {}, 'Final scoreboard'));
  const sorted = playerIds().slice().sort((a, b) => (DB.scoreboard[b] || 0) - (DB.scoreboard[a] || 0));
  const list = h('div', { class: 'player-list' });
  sorted.forEach((id, i) => {
    list.appendChild(h('div', { class: 'player-row' }, [
      h('span', {}, `${i + 1}. ${playerName(id)}`),
      h('span', { class: 'score' }, String(DB.scoreboard[id] || 0))
    ]));
  });
  wrap.appendChild(h('div', { class: 'card' }, list));
  const hostView = viewingAs === DB.meta.hostId;
  wrap.appendChild(h('button', {
    class: 'primary', disabled: !hostView, onclick: () => {
      transactionalCommit(() => {
        const keptPlayers = DB.players; const hostId = DB.meta.hostId;
        const fresh = freshDB();
        fresh.players = keptPlayers; fresh.meta.hostId = hostId;
        Object.keys(fresh.players).forEach(id => { fresh.scoreboard[id] = 0; });
        DB = fresh;
      });
    }
  }, hostView ? 'Start a new session' : 'Waiting for host to start a new session'));
  return wrap;
}

render();
