// ============================================================
// SayAnything / Trivia Bluff / Imposter - Firebase-backed multiplayer prototype
// Same architecture as the main build: every browser window with the
// room code is a genuinely separate player. State lives at
// /batch3/{ROOM_CODE} in Realtime Database and is mirrored into the
// local DB object by a live onValue listener.
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import { getDatabase, ref, set, onValue, runTransaction } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-database.js";

// Same Firebase project as the main build and batch 2.
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
const ROUND_TYPES = ['sayAnything', 'triviaBluff', 'imposter'];
const TRIVIABLUFF_CATEGORY_OPTIONS = 4;
const IMPOSTER_CLUE_ROUNDS = 2;
const SAYANYTHING_INSTANCES = 3;
const TRIVIABLUFF_INSTANCES = 5;
const IMPOSTER_INSTANCES = 2;

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
// viewingAs is THIS browser's own player id, fixed once joined, no
// more switching between players from one tab.
let ROOM_CODE = null;
let DB = null;
let viewingAs = null;
let joined = false;

const ROOM_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function generateRoomCode() { return Array.from({ length: 4 }, () => ROOM_LETTERS[Math.floor(Math.random() * ROOM_LETTERS.length)]).join(''); }

function freshDB() {
  return {
    meta: { hostId: null, is18Plus: false, status: 'lobby' },
    players: {},           // id -> { name, joinedAt }
    scoreboard: {},         // id -> number
    session: { roundOrder: [], currentRoundIndex: -1, currentRound: null },
    roundState: null
  };
}

// Firebase drops empty objects entirely, so paths that were emptied
// come back as undefined. Patch them back to safe defaults after
// every snapshot.
function normalizeDB() {
  if (!DB) return;
  DB.meta = DB.meta || { hostId: null, is18Plus: false, status: 'lobby' };
  DB.players = DB.players || {};
  DB.scoreboard = DB.scoreboard || {};
  DB.session = DB.session || { roundOrder: [], currentRoundIndex: -1, currentRound: null };
  normalizeRoundState();
}

// Firebase drops empty objects/arrays entirely rather than storing
// them as {} or [], so any collection that starts empty (nobody's
// answered/voted yet, or a used-id list before its first entry)
// comes back as `undefined` on every OTHER client's snapshot, not {}
// or []. Every round keeps at least one such collection, so this has
// to run for whichever round type is currently active, every time a
// snapshot lands.
function normalizeRoundState() {
  const rs = DB.roundState;
  if (!rs) return;
  if (rs.type === 'sayAnything') {
    rs.answers = rs.answers || {};
    rs.votes = rs.votes || {};
    rs.usedPromptIds = rs.usedPromptIds || [];
  } else if (rs.type === 'triviaBluff') {
    rs.fakeAnswers = rs.fakeAnswers || {};
    rs.votes = rs.votes || {};
    rs.categoryOptions = rs.categoryOptions || [];
    rs.shuffledOptions = rs.shuffledOptions || [];
    rs.usedQuestionIds = rs.usedQuestionIds || [];
  } else if (rs.type === 'imposter') {
    rs.clues = rs.clues || { 1: {}, 2: {} };
    rs.clues[1] = rs.clues[1] || {};
    rs.clues[2] = rs.clues[2] || {};
    rs.votes = rs.votes || {};
    rs.usedCelebIds = rs.usedCelebIds || [];
  }
}

async function commit() {
  // Full-object overwrite. Only ever safe for the very first write to
  // a brand new room (nobody else can be writing to it yet).
  // Everything that happens once players are in a shared round goes
  // through transactionalCommit below instead.
  render();
  if (!ROOM_CODE) return;
  try { await set(ref(rtdb, 'batch3/' + ROOM_CODE), DB); }
  catch (e) { console.error('Firebase write failed:', e); }
}

// Multiple players write to the same lobby object at once. A plain
// set() overwrites the whole object with whatever THIS client's
// local copy looked like, silently discarding anyone else's write
// that landed in between. A transaction fetches the true current
// server value fresh, lets mutatorFn mutate THAT, and Firebase
// retries automatically if another write lands in the meantime, so
// nobody's contribution gets lost.
async function transactionalCommit(mutatorFn) {
  if (!ROOM_CODE) return;
  const lobbyRef = ref(rtdb, 'batch3/' + ROOM_CODE);
  try {
    const result = await runTransaction(lobbyRef, (currentDB) => {
      if (currentDB === null) return currentDB; // room not created yet server-side, abort quietly
      const savedDB = DB;
      DB = currentDB;
      normalizeDB();
      mutatorFn();
      const out = DB;
      DB = savedDB;
      return out;
    });
    // Don't wait on the separate onValue round-trip to find out our
    // own write succeeded, paint the confirmed result immediately.
    if (result && result.committed && result.snapshot) {
      DB = result.snapshot.val() || DB;
      normalizeDB();
      render();
    }
  } catch (e) { console.error('Firebase transaction failed:', e); }
}

function playerIds() { return DB ? Object.keys(DB.players) : []; }
function playerName(id) { return DB && DB.players[id] ? DB.players[id].name : '-'; }
function isHost(id) { return DB && DB.meta.hostId === id; }
function addScore(id, delta) { DB.scoreboard[id] = (DB.scoreboard[id] || 0) + delta; }

function identityKey() { return 'batch3_identity_' + ROOM_CODE; }

async function enterRoom(code, isNewRoom) {
  await _authReady;
  ROOM_CODE = code;
  localStorage.setItem('batch3_last_room', code);
  const roomRef = ref(rtdb, 'batch3/' + code);
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
    DB.session.roundOrder = shuffle(ROUND_TYPES); // engine-randomised, not host-visible ahead of time
    DB.session.currentRoundIndex = -1;
    advanceToNextRound();
  });
}

// Ends the round that just finished (if any) with a scored summary
// showing exactly how this round moved the leaderboard, rather than
// a running scoreboard visible the whole way through. The very first
// round of a session (nothing to summarise yet) skips straight in.
function advanceToNextRound() {
  const justFinishedARound = !!DB.roundState;
  if (justFinishedARound) {
    const before = DB.session.scoreboardAtRoundStart || {};
    const delta = {};
    playerIds().forEach(id => { delta[id] = round1dp((DB.scoreboard[id] || 0) - (before[id] || 0)); });
    DB.session.lastRoundSummary = { roundType: DB.session.currentRound, delta };
  }

  DB.session.currentRoundIndex++;

  if (justFinishedARound) {
    DB.meta.status = 'round_summary';
    DB.roundState = null;
    return;
  }
  startPendingRound();
}
function startPendingRound() {
  if (DB.session.currentRoundIndex >= DB.session.roundOrder.length) {
    DB.meta.status = 'session_end';
    DB.roundState = null;
    return;
  }
  const type = DB.session.roundOrder[DB.session.currentRoundIndex];
  DB.session.currentRound = type;
  DB.meta.status = 'in_round';
  DB.session.scoreboardAtRoundStart = { ...DB.scoreboard };
  if (type === 'sayAnything') startSayAnything();
  else if (type === 'triviaBluff') startTriviaBluff();
  else if (type === 'imposter') startImposter();
}
function continueFromRoundSummary() {
  transactionalCommit(() => { startPendingRound(); });
}
function round1dp(n) { return Math.round(n * 10) / 10; }

// ============================================================
// ROUND - SayAnything
// 3 instances per session. Everyone (including any named subject in
// a personalised prompt) writes their own answer to the same prompt.
// Anonymous reveal, everyone votes for funniest (not their own),
// +1 point per vote received.
// ============================================================
function sayAnythingPool() {
  const tiers = DB.meta.is18Plus ? ['standard', '18plus'] : ['standard'];
  return tiers.flatMap(t => CONTENT.sayAnything[t]);
}
function startSayAnything() {
  DB.roundState = {
    type: 'sayAnything',
    instanceIndex: 0,
    totalInstances: SAYANYTHING_INSTANCES,
    usedPromptIds: [],
    phase: 'writing',
    prompt: null,
    player1: null,
    player2: null,
    answers: {},
    votes: {}
  };
  sayAnythingStartInstance();
}
function sayAnythingPickPrompt() {
  const rs = DB.roundState;
  const pool = sayAnythingPool();
  const remaining = pool.filter(p => !rs.usedPromptIds.includes(p.id));
  const chosen = remaining.length ? pick(remaining) : pick(pool);
  rs.usedPromptIds.push(chosen.id);
  return chosen;
}
function sayAnythingStartInstance() {
  const rs = DB.roundState;
  const prompt = sayAnythingPickPrompt();
  const ids = playerIds();

  let player1 = null, player2 = null;
  if (prompt.type === 'single') {
    player1 = pick(ids);
  } else if (prompt.type === 'double') {
    [player1, player2] = sample(ids, 2);
  }

  rs.prompt = prompt;
  rs.player1 = player1;
  rs.player2 = player2;
  rs.answers = {};
  rs.votes = {};
  rs.phase = 'writing';
}
function sayAnythingPromptText() {
  const rs = DB.roundState;
  let text = rs.prompt.text;
  if (rs.player1) text = text.replace('{Player1}', playerName(rs.player1)).replace('{Player}', playerName(rs.player1));
  if (rs.player2) text = text.replace('{Player2}', playerName(rs.player2));
  return text;
}
function sayAnythingSubmitAnswer(playerId, text) {
  if (!text.trim()) return;
  transactionalCommit(() => {
    const rs = DB.roundState;
    if (rs.phase !== 'writing') return; // phase already moved on, a late click, ignore
    rs.answers[playerId] = text.trim();
    if (Object.keys(rs.answers).length >= playerIds().length) rs.phase = 'voting';
  });
}
function sayAnythingSubmitVote(voterId, ownerId) {
  if (voterId === ownerId) return; // can't vote your own answer
  transactionalCommit(() => {
    const rs = DB.roundState;
    if (rs.phase !== 'voting') return; // phase already moved on, a late click, ignore
    rs.votes[voterId] = ownerId;
    if (Object.keys(rs.votes).length >= playerIds().length) sayAnythingReveal();
  });
}
function sayAnythingReveal() {
  const rs = DB.roundState;
  rs.phase = 'reveal';
  const tally = {};
  Object.values(rs.votes).forEach(ownerId => { tally[ownerId] = (tally[ownerId] || 0) + 1; });
  Object.entries(tally).forEach(([ownerId, count]) => addScore(ownerId, count));
  rs.voteTally = tally;
}
function sayAnythingNext() {
  transactionalCommit(() => {
    const rs = DB.roundState;
    rs.instanceIndex++;
    if (rs.instanceIndex >= rs.totalInstances) { advanceToNextRound(); return; }
    sayAnythingStartInstance();
  });
}

// ============================================================
// ROUND - Trivia Bluff
// 5 instances per session. Each instance: one player (rotated) picks
// from 4 random category options, a real question is pulled from
// that category, everyone (including the picker) writes a fake
// answer, the real answer is shuffled in anonymously, everyone votes
// on which is real. +1 per correct guess, +2 to a fake-answer writer
// per person their fake fools. Adult Trivia is just a 15th category
// offered like any other when the 18+ toggle is on, no forced
// minimum per session.
// ============================================================
function triviaCategoryNames() {
  const names = Object.keys(CONTENT.triviaBluff).filter(c => c !== 'Adult Trivia');
  return DB.meta.is18Plus ? [...names, 'Adult Trivia'] : names;
}
function startTriviaBluff() {
  DB.roundState = {
    type: 'triviaBluff',
    instanceIndex: 0,
    totalInstances: TRIVIABLUFF_INSTANCES,
    pickerOrder: shuffle(playerIds()),
    usedQuestionIds: [],
    phase: 'choosing_category',
    picker: null,
    categoryOptions: [],
    chosenCategory: null,
    question: null,
    fakeAnswers: {},
    votes: {},
    shuffledOptions: []
  };
  triviaBluffStartInstance();
}
function triviaBluffStartInstance() {
  const rs = DB.roundState;
  const picker = rs.pickerOrder[rs.instanceIndex % rs.pickerOrder.length];
  const allCats = triviaCategoryNames();
  const options = sample(allCats, Math.min(TRIVIABLUFF_CATEGORY_OPTIONS, allCats.length));

  rs.picker = picker;
  rs.categoryOptions = options;
  rs.chosenCategory = null;
  rs.question = null;
  rs.fakeAnswers = {};
  rs.votes = {};
  rs.shuffledOptions = [];
  rs.phase = 'choosing_category';
}
function triviaBluffChooseCategory(playerId, category) {
  if (playerId !== DB.roundState.picker) return;
  transactionalCommit(() => {
    const rs = DB.roundState;
    if (rs.phase !== 'choosing_category') return; // phase already moved on, a late click, ignore
    if (!rs.categoryOptions.includes(category)) return;
    const bank = CONTENT.triviaBluff[category];
    const remaining = bank.filter(q => !rs.usedQuestionIds.includes(q.id));
    const chosen = remaining.length ? pick(remaining) : pick(bank);
    rs.usedQuestionIds.push(chosen.id);
    rs.chosenCategory = category;
    rs.question = chosen;
    rs.phase = 'writing';
  });
}
function triviaBluffSubmitFake(playerId, text) {
  if (!text.trim()) return;
  transactionalCommit(() => {
    const rs = DB.roundState;
    if (rs.phase !== 'writing') return; // phase already moved on, a late click, ignore
    if (text.trim().toLowerCase() === rs.question.a.trim().toLowerCase()) return; // rejects a fake that just restates the real answer
    rs.fakeAnswers[playerId] = text.trim();
    if (Object.keys(rs.fakeAnswers).length >= playerIds().length) {
      rs.phase = 'voting';
      rs.shuffledOptions = triviaBluffBuildOptions(rs);
    }
  });
}
// Builds the anonymous, shuffled option list once, so it doesn't
// reshuffle under players mid-vote. "real" is a literal marker, not
// a player id, so it can't collide with one.
function triviaBluffBuildOptions(rs) {
  const opts = Object.entries(rs.fakeAnswers).map(([pid, text]) => ({ ownerId: pid, text }));
  opts.push({ ownerId: 'real', text: rs.question.a });
  return shuffle(opts);
}
function triviaBluffSubmitVote(voterId, ownerId) {
  if (voterId === ownerId) return; // can't vote your own fake
  transactionalCommit(() => {
    const rs = DB.roundState;
    if (rs.phase !== 'voting') return; // phase already moved on, a late click, ignore
    rs.votes[voterId] = ownerId;
    if (Object.keys(rs.votes).length >= playerIds().length) triviaBluffReveal();
  });
}
function triviaBluffReveal() {
  const rs = DB.roundState;
  rs.phase = 'reveal';
  Object.entries(rs.votes).forEach(([voterId, ownerId]) => {
    if (ownerId === 'real') addScore(voterId, 1); // correct guess
    else addScore(ownerId, 2); // fake writer fooled someone
  });
}
function triviaBluffNext() {
  transactionalCommit(() => {
    const rs = DB.roundState;
    rs.instanceIndex++;
    if (rs.instanceIndex >= rs.totalInstances) { advanceToNextRound(); return; }
    triviaBluffStartInstance();
  });
}

// ============================================================
// ROUND - Imposter
// 2 instances per session, 4 to 12 players. Engine picks a
// celebrity/historical figure vs a real lobby player randomly each
// instance. One player is the imposter and sees only a vague
// category hint, everyone else sees the real subject. Two rounds of
// one-word clues, then everyone votes (no self-votes). Confirmed
// scoring:
//   - correct accuser (voted for the real imposter):          +1
//   - wrong accuser (voted for an innocent player):            -1
//   - the imposter, per player who correctly accused them:     -1 each
//   - the imposter, per player who did NOT accuse them:        +1 each
//   - a wrongly-accused innocent, per player who accused them: -2 each
//   - no separate bonus for the imposter naming the real subject.
// This formula handles ties on its own (each suspect's points scale
// with however many votes they personally received), so there's no
// separate tie-breaking branch needed.
// ============================================================
function imposterPool() { return CONTENT.imposter; } // celebrities are always standard-tier, no 18+ layer
function startImposter() {
  DB.roundState = {
    type: 'imposter',
    instanceIndex: 0,
    totalInstances: IMPOSTER_INSTANCES,
    usedCelebIds: [],
    phase: 'clues',
    imposterId: null,
    subjectMode: null,
    subjectName: null,
    categoryHint: null,
    clueRound: 1,
    clues: { 1: {}, 2: {} },
    votes: {}
  };
  imposterStartInstance();
}
function imposterStartInstance() {
  const rs = DB.roundState;
  const ids = playerIds();
  const imposterId = pick(ids);
  const subjectMode = Math.random() < 0.5 ? 'celebrity' : 'player';

  let subjectName, categoryHint;
  if (subjectMode === 'celebrity' || ids.length < 2) {
    const pool = imposterPool();
    const remaining = pool.filter(c => !rs.usedCelebIds.includes(c.id));
    const chosen = remaining.length ? pick(remaining) : pick(pool);
    rs.usedCelebIds.push(chosen.id);
    subjectName = chosen.name;
    categoryHint = chosen.category;
    rs.subjectMode = 'celebrity';
  } else {
    const candidates = ids.filter(id => id !== imposterId);
    subjectName = playerName(pick(candidates));
    categoryHint = 'Someone in this group';
    rs.subjectMode = 'player';
  }

  rs.imposterId = imposterId;
  rs.subjectName = subjectName;
  rs.categoryHint = categoryHint;
  rs.clueRound = 1;
  rs.clues = { 1: {}, 2: {} };
  rs.votes = {};
  rs.phase = 'clues';
}
function imposterViewFor(playerId) {
  const rs = DB.roundState;
  if (playerId === rs.imposterId) return { hint: rs.categoryHint };
  return { name: rs.subjectName };
}
function imposterSubmitClue(playerId, word) {
  if (!word.trim()) return;
  transactionalCommit(() => {
    const rs = DB.roundState;
    if (rs.phase !== 'clues') return; // phase already moved on, a late click, ignore
    rs.clues[rs.clueRound][playerId] = word.trim().split(/\s+/)[0]; // enforce one word
    if (Object.keys(rs.clues[rs.clueRound]).length >= playerIds().length) {
      if (rs.clueRound < IMPOSTER_CLUE_ROUNDS) rs.clueRound++;
      else rs.phase = 'voting';
    }
  });
}
function imposterSubmitVote(voterId, suspectId) {
  if (voterId === suspectId) return; // no self-votes
  transactionalCommit(() => {
    const rs = DB.roundState;
    if (rs.phase !== 'voting') return; // phase already moved on, a late click, ignore
    rs.votes[voterId] = suspectId;
    if (Object.keys(rs.votes).length >= playerIds().length) imposterReveal();
  });
}
function imposterReveal() {
  const rs = DB.roundState;
  rs.phase = 'reveal';
  const imposterId = rs.imposterId;
  const others = playerIds().filter(id => id !== imposterId);
  let accusersOfImposter = 0;

  Object.entries(rs.votes).forEach(([voterId, suspectId]) => {
    if (suspectId === imposterId) {
      addScore(voterId, 1);       // correct accuser
      addScore(imposterId, -1);   // imposter penalised per correct accuser
      accusersOfImposter++;
    } else {
      addScore(suspectId, -2);    // wrongly-accused innocent
      addScore(voterId, -1);      // wrong accuser
    }
  });

  const fooledCount = others.length - accusersOfImposter;
  addScore(imposterId, fooledCount); // +1 per player who didn't suspect the imposter
}
function imposterNext() {
  transactionalCommit(() => {
    const rs = DB.roundState;
    rs.instanceIndex++;
    if (rs.instanceIndex >= rs.totalInstances) { advanceToNextRound(); return; }
    imposterStartInstance();
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
  else if (DB.meta.status === 'round_summary') screen.appendChild(renderRoundSummary());
  else if (DB.meta.status === 'session_end') screen.appendChild(renderSessionEnd());
  appEl.appendChild(screen);
  appEl.appendChild(h('div', { class: 'footer-note' }, `Room ${ROOM_CODE} - synced live over Firebase.`));
}

// ---------------- Room gate (before joining any lobby) ----------------
function renderRoomGate() {
  const wrap = h('div', { class: 'screen' });
  wrap.appendChild(h('div', { class: 'eyebrow' }, 'Batch 3'));
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
  const lastRoom = localStorage.getItem('batch3_last_room');
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

// ---------------- Join form ----------------
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

// ---------------- Lobby screen ----------------
function renderLobby() {
  const wrap = document.createDocumentFragment();
  wrap.appendChild(h('div', { class: 'eyebrow' }, 'Lobby ' + ROOM_CODE));
  wrap.appendChild(h('h1', {}, 'SayAnything / Trivia Bluff / Imposter'));
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
  if (type === 'sayAnything') return renderSayAnything();
  if (type === 'triviaBluff') return renderTriviaBluff();
  if (type === 'imposter') return renderImposter();
  return h('div', {}, 'Unknown round');
}

function roundBanner(title, indexLabel) {
  return h('div', { class: 'round-banner' }, [
    h('div', {}, [h('div', { class: 'eyebrow' }, DB.session.currentRound), h('h2', {}, title)]),
    h('div', { class: 'count' }, indexLabel)
  ]);
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

// ---------------- SayAnything UI ----------------
function renderSayAnything() {
  const rs = DB.roundState;
  const wrap = document.createDocumentFragment();
  wrap.appendChild(roundBanner('SayAnything', `Round ${rs.instanceIndex + 1} / ${rs.totalInstances}`));
  wrap.appendChild(h('div', { class: 'card' }, [
    h('div', { class: 'prompt-text' }, sayAnythingPromptText())
  ]));

  if (rs.phase === 'writing') {
    if (!viewingAs) return wrap;
    if (rs.answers[viewingAs] !== undefined) {
      wrap.appendChild(waitingBlock(`Answer locked in. Waiting on ${playerIds().length - Object.keys(rs.answers).length} more player(s)...`));
    } else {
      wrap.appendChild(writeBox('Your answer.', (t) => sayAnythingSubmitAnswer(viewingAs, t)));
    }
  } else if (rs.phase === 'voting') {
    if (rs.votes[viewingAs] !== undefined) {
      wrap.appendChild(waitingBlock(`Vote locked in. Waiting on ${playerIds().length - Object.keys(rs.votes).length} more voter(s)...`));
    } else {
      const grid = h('div', { class: 'option-grid' });
      Object.entries(rs.answers).forEach(([ownerId, text]) => {
        if (ownerId === viewingAs) return; // can't vote your own answer
        grid.appendChild(h('div', { class: 'answer-slot', onclick: () => sayAnythingSubmitVote(viewingAs, ownerId) }, text));
      });
      wrap.appendChild(h('p', { class: 'muted' }, 'Vote for the funniest.'));
      wrap.appendChild(grid);
    }
  } else if (rs.phase === 'reveal') {
    const grid = h('div', { class: 'option-grid' });
    Object.entries(rs.answers).forEach(([ownerId, text]) => {
      const votes = rs.voteTally[ownerId] || 0;
      grid.appendChild(h('div', { class: 'answer-slot' }, [
        text,
        h('div', { class: 'author' }, `Written by ${playerName(ownerId)} - ${votes} vote${votes === 1 ? '' : 's'}`)
      ]));
    });
    wrap.appendChild(grid);
    wrap.appendChild(h('button', { class: 'primary', onclick: sayAnythingNext }, rs.instanceIndex + 1 >= rs.totalInstances ? 'Continue to next round' : 'Next prompt'));
  }
  return wrap;
}

// ---------------- Trivia Bluff UI ----------------
function renderTriviaBluff() {
  const rs = DB.roundState;
  const wrap = document.createDocumentFragment();
  wrap.appendChild(roundBanner('Trivia Bluff', `Round ${rs.instanceIndex + 1} / ${rs.totalInstances}`));

  if (rs.phase === 'choosing_category') {
    wrap.appendChild(h('div', { class: 'card' }, [
      h('span', { class: 'eyebrow' }, 'Category picker'),
      h('div', { style: 'font-weight:700;margin:2px 0 8px;' }, playerName(rs.picker))
    ]));
    if (viewingAs === rs.picker) {
      const grid = h('div', { class: 'option-grid' });
      rs.categoryOptions.forEach(cat => {
        grid.appendChild(h('button', { class: 'option-btn', onclick: () => triviaBluffChooseCategory(viewingAs, cat) }, cat));
      });
      wrap.appendChild(h('p', { class: 'muted' }, 'Pick a category. You will not know the answer either, you just choose the topic.'));
      wrap.appendChild(grid);
    } else {
      wrap.appendChild(waitingBlock(`Waiting for ${playerName(rs.picker)} to pick a category...`));
    }
  } else if (rs.phase === 'writing') {
    wrap.appendChild(h('div', { class: 'card' }, [
      h('span', { class: 'eyebrow' }, rs.chosenCategory),
      h('div', { class: 'prompt-text' }, rs.question.q)
    ]));
    if (rs.fakeAnswers[viewingAs] !== undefined) {
      wrap.appendChild(waitingBlock(`Fake answer locked in. Waiting on ${playerIds().length - Object.keys(rs.fakeAnswers).length} more player(s)...`));
    } else {
      wrap.appendChild(writeBox('Write a convincing fake answer.', (t) => triviaBluffSubmitFake(viewingAs, t)));
    }
  } else if (rs.phase === 'voting') {
    wrap.appendChild(h('div', { class: 'card' }, [
      h('span', { class: 'eyebrow' }, rs.chosenCategory),
      h('div', { class: 'prompt-text' }, rs.question.q)
    ]));
    if (rs.votes[viewingAs] !== undefined) {
      wrap.appendChild(waitingBlock(`Vote locked in. Waiting on ${playerIds().length - Object.keys(rs.votes).length} more voter(s)...`));
    } else {
      const grid = h('div', { class: 'option-grid' });
      rs.shuffledOptions.forEach(opt => {
        if (opt.ownerId === viewingAs) return; // can't vote your own fake
        grid.appendChild(h('div', { class: 'answer-slot', onclick: () => triviaBluffSubmitVote(viewingAs, opt.ownerId) }, opt.text));
      });
      wrap.appendChild(h('p', { class: 'muted' }, 'Tap the one you think is real.'));
      wrap.appendChild(grid);
    }
  } else if (rs.phase === 'reveal') {
    const grid = h('div', { class: 'option-grid' });
    rs.shuffledOptions.forEach(opt => {
      const votesFor = Object.values(rs.votes).filter(v => v === opt.ownerId).length;
      const cls = 'answer-slot' + (opt.ownerId === 'real' ? ' correct' : '');
      grid.appendChild(h('div', { class: cls }, [
        opt.text,
        h('div', { class: 'author' }, `${opt.ownerId === 'real' ? 'The real answer' : 'Written by ' + playerName(opt.ownerId)} - ${votesFor} vote${votesFor === 1 ? '' : 's'}`)
      ]));
    });
    wrap.appendChild(grid);
    wrap.appendChild(h('button', { class: 'primary', onclick: triviaBluffNext }, rs.instanceIndex + 1 >= rs.totalInstances ? 'Continue to next round' : 'Next question'));
  }
  return wrap;
}

// ---------------- Imposter UI ----------------
function renderImposter() {
  const rs = DB.roundState;
  const wrap = document.createDocumentFragment();
  wrap.appendChild(roundBanner('Imposter', `Round ${rs.instanceIndex + 1} / ${rs.totalInstances}`));

  const view = imposterViewFor(viewingAs);
  wrap.appendChild(h('div', { class: 'card raised' }, [
    h('span', { class: 'eyebrow' }, view.name ? 'Subject' : 'You are the imposter'),
    h('div', { class: 'prompt-text' }, view.name ? view.name : `Category hint: ${view.hint}`)
  ]));

  if (rs.phase === 'clues') {
    wrap.appendChild(h('p', { class: 'muted' }, `Clue round ${rs.clueRound} / ${IMPOSTER_CLUE_ROUNDS}. One word only.`));
    if (rs.clues[rs.clueRound][viewingAs] !== undefined) {
      wrap.appendChild(waitingBlock(`Clue locked in. Waiting on ${playerIds().length - Object.keys(rs.clues[rs.clueRound]).length} more player(s)...`));
    } else {
      wrap.appendChild(writeBox('Your one-word clue.', (t) => imposterSubmitClue(viewingAs, t)));
    }
  } else if (rs.phase === 'voting') {
    if (rs.votes[viewingAs] !== undefined) {
      wrap.appendChild(waitingBlock(`Vote locked in. Waiting on ${playerIds().length - Object.keys(rs.votes).length} more voter(s)...`));
    } else {
      const grid = h('div', { class: 'option-grid' });
      playerIds().filter(id => id !== viewingAs).forEach(id => {
        grid.appendChild(h('div', { class: 'answer-slot', onclick: () => imposterSubmitVote(viewingAs, id) }, playerName(id)));
      });
      wrap.appendChild(h('p', { class: 'muted' }, 'Who do you think the imposter is?'));
      wrap.appendChild(grid);
    }
  } else if (rs.phase === 'reveal') {
    wrap.appendChild(h('div', { class: 'card raised' }, [
      h('span', { class: 'eyebrow' }, 'The imposter was'),
      h('div', { class: 'prompt-text' }, playerName(rs.imposterId))
    ]));
    const votesForImposter = Object.values(rs.votes).filter(v => v === rs.imposterId).length;
    wrap.appendChild(h('div', { class: 'score-flash' }, `${votesForImposter} of ${playerIds().length - 1} correctly suspected them.`));
    wrap.appendChild(h('button', { class: 'primary', onclick: imposterNext }, rs.instanceIndex + 1 >= rs.totalInstances ? 'Continue to next round' : 'Next imposter'));
  }
  return wrap;
}

// ---------------- Session end ----------------
const ROUND_DISPLAY_NAMES = { sayAnything: 'SayAnything', triviaBluff: 'Trivia Bluff', imposter: 'Imposter' };

function renderRoundSummary() {
  const wrap = document.createDocumentFragment();
  const summary = DB.session.lastRoundSummary;
  wrap.appendChild(h('div', { class: 'eyebrow' }, 'Round complete'));
  wrap.appendChild(h('h1', {}, ROUND_DISPLAY_NAMES[summary.roundType] || summary.roundType));

  const list = h('div', { class: 'player-list' });
  playerIds()
    .slice()
    .sort((a, b) => (summary.delta[b] || 0) - (summary.delta[a] || 0))
    .forEach(id => {
      const d = summary.delta[id] || 0;
      const sign = d > 0 ? '+' : '';
      list.appendChild(h('div', { class: 'player-row' }, [
        h('span', {}, playerName(id)),
        h('span', {}, [
          h('span', { class: d < 0 ? 'score-flash negative' : 'score-flash', style: 'padding:3px 9px;font-size:13px;margin-right:10px;display:inline-flex;' }, `${sign}${d}`),
          h('span', { class: 'score' }, String(DB.scoreboard[id] || 0))
        ])
      ]));
    });
  wrap.appendChild(h('div', { class: 'card' }, [h('div', { class: 'eyebrow' }, 'This round - running total'), list]));

  wrap.appendChild(h('button', { class: 'primary', onclick: continueFromRoundSummary }, 'Continue'));
  return wrap;
}

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
