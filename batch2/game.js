// ============================================================
// Party Game — Batch 2 test build
// Same Firebase-transaction architecture as the main build.
// This file only wires up Ranking Wars, Secret Opinions and
// Crystal Ball, so it can be tested standalone without touching
// the three already-working rounds. Merge later = copy the round
// engine + render functions below into the main game.js and add
// these three type strings to its ROUND_TYPES list.
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import { getDatabase, ref, set, onValue, runTransaction } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-database.js";

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
const ROUND_TYPES = ['rankingWars', 'secretOpinions', 'crystalBall'];

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
function round1dp(n) { return Math.round(n * 10) / 10; }
function numberInRange(rawValue, min, max) {
  if (rawValue === '' || rawValue === null || rawValue === undefined) return false;
  const v = Number(rawValue);
  return Number.isFinite(v) && v >= min && v <= max;
}
function normalizeWord(w) { return (w || '').trim().toLowerCase().replace(/[^a-z0-9]/g, ''); }
function stripPlural(w) {
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('es') && w.length > 3) return w.slice(0, -2);
  if (w.endsWith('s') && w.length > 3) return w.slice(0, -1);
  return w;
}
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}
// Loose match: ignores case/punctuation, treats simple plurals as equal,
// and tolerates a small typo (more slack on longer words).
function wordsMatch(guess, actual) {
  const g = stripPlural(normalizeWord(guess));
  const a = stripPlural(normalizeWord(actual));
  if (!g || !a) return false;
  if (g === a) return true;
  const tolerance = Math.max(a.length, g.length) <= 5 ? 1 : 2;
  return levenshtein(g, a) <= tolerance;
}

// ---------------- Store ----------------
let ROOM_CODE = null;
let DB = null;
let viewingAs = null;
let joined = false;

const ROOM_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function generateRoomCode() { return Array.from({ length: 4 }, () => ROOM_LETTERS[Math.floor(Math.random() * ROOM_LETTERS.length)]).join(''); }

function freshDB() {
  return {
    meta: { hostId: null, is18Plus: false, status: 'lobby' },
    players: {},
    scoreboard: {},
    session: { roundOrder: [], currentRoundIndex: -1, currentRound: null },
    roundState: null
  };
}

function normalizeDB() {
  if (!DB) return;
  DB.meta = DB.meta || { hostId: null, is18Plus: false, status: 'lobby' };
  DB.players = DB.players || {};
  DB.scoreboard = DB.scoreboard || {};
  DB.session = DB.session || { roundOrder: [], currentRoundIndex: -1, currentRound: null };
  normalizeRoundState();
}

// Firebase drops empty objects/arrays entirely, so any collection that
// starts empty comes back as `undefined` on every OTHER client's
// snapshot, not {}. Restore whichever round is currently active.
function normalizeRoundState() {
  const rs = DB.roundState;
  if (!rs) return;
  if (rs.type === 'rankingWars') {
    rs.rankings = rs.rankings || {};
    rs.usedCategories = rs.usedCategories || [];
  } else if (rs.type === 'secretOpinions') {
    rs.pendingAnswers = rs.pendingAnswers || {};
    rs.answers = rs.answers || {};
    rs.revealOrder = rs.revealOrder || [];
    rs.guessedBy = rs.guessedBy || {};
    rs.currentGuesses = rs.currentGuesses || {};
    rs.passResults = rs.passResults || [];
    rs.usedTopic = rs.usedTopic || [];
    rs.usedPickAPlayer = rs.usedPickAPlayer || [];
  } else if (rs.type === 'crystalBall') {
    rs.pendingGuesses = rs.pendingGuesses || {};
    rs.guesses = rs.guesses || {};
    rs.usedBinary = rs.usedBinary || [];
    rs.usedNumber = rs.usedNumber || [];
    rs.usedSingleWord = rs.usedSingleWord || [];
  }
}

async function commit() {
  render();
  if (!ROOM_CODE) return;
  try { await set(ref(rtdb, 'lobbies/' + ROOM_CODE), DB); }
  catch (e) { console.error('Firebase write failed:', e); }
}

async function transactionalCommit(mutatorFn) {
  if (!ROOM_CODE) return;
  const lobbyRef = ref(rtdb, 'lobbies/' + ROOM_CODE);
  try {
    const result = await runTransaction(lobbyRef, (currentDB) => {
      if (currentDB === null) return currentDB;
      const savedDB = DB;
      DB = currentDB;
      normalizeDB();
      mutatorFn();
      const out = DB;
      DB = savedDB;
      return out;
    });
    if (result && result.committed && result.snapshot) {
      DB = result.snapshot.val() || DB;
      normalizeDB();
      render();
    }
  } catch (e) { console.error('Firebase transaction failed:', e); }
}

function playerIds() { return DB ? Object.keys(DB.players) : []; }
function playerName(id) { return DB && DB.players[id] ? DB.players[id].name : '?'; }
function isHost(id) { return DB && DB.meta.hostId === id; }
function addScore(id, delta) { DB.scoreboard[id] = round1dp((DB.scoreboard[id] || 0) + delta); }

function identityKey() { return 'batch2_identity_' + ROOM_CODE; }

async function enterRoom(code, isNewRoom) {
  await _authReady;
  ROOM_CODE = code;
  localStorage.setItem('batch2_last_room', code);
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
function leaveRoom() { ROOM_CODE = null; DB = null; viewingAs = null; joined = false; render(); }

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
    DB.session.roundOrder = shuffle(ROUND_TYPES);
    DB.session.currentRoundIndex = -1;
    advanceToNextRound();
  });
}

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
  if (type === 'rankingWars') startRankingWars();
  else if (type === 'secretOpinions') startSecretOpinions();
  else if (type === 'crystalBall') startCrystalBall();
}
function continueFromRoundSummary() { transactionalCommit(() => { startPendingRound(); }); }

// ============================================================
// ROUND — Ranking Wars
// ============================================================
function rankingTotalInstances() { return playerIds().length <= 8 ? 4 : 3; }
function startRankingWars() {
  DB.roundState = {
    type: 'rankingWars',
    totalInstances: rankingTotalInstances(),
    instanceIndex: 0,
    usedCategories: [],
    phase: 'ranking',
    category: '',
    rankings: {}
  };
  rankingStartInstance();
}
function rankingStartInstance() {
  const rs = DB.roundState;
  const bank = DB.meta.is18Plus ? CONTENT.rankingWars.standard.concat(CONTENT.rankingWars.adult) : CONTENT.rankingWars.standard;
  const remaining = bank.filter(c => !rs.usedCategories.includes(c));
  const category = remaining.length ? pick(remaining) : pick(bank);
  rs.usedCategories.push(category);
  rs.category = category;
  rs.phase = 'ranking';
  rs.rankings = {};
}
function rankingSubmit(playerId, orderedIds) {
  transactionalCommit(() => {
    const rs = DB.roundState;
    if (rs.phase !== 'ranking') return;
    rs.rankings[playerId] = orderedIds;
    if (Object.keys(rs.rankings).length >= playerIds().length) rankingReveal();
  });
}
function rankingReveal() {
  const rs = DB.roundState;
  rs.phase = 'reveal';
  const players = playerIds();
  const n = players.length;
  const avgRank = {};
  const roundedAvg = {};
  players.forEach(target => {
    let sum = 0;
    players.forEach(rater => { sum += (rs.rankings[rater].indexOf(target) + 1); });
    avgRank[target] = round1dp(sum / n);
    roundedAvg[target] = Math.round(sum / n);
  });
  players.forEach(rater => {
    players.forEach(target => {
      const placedAt = rs.rankings[rater].indexOf(target) + 1;
      if (placedAt === roundedAvg[target]) addScore(rater, 1);
    });
  });
  let unanimousFirst = null;
  players.forEach(target => {
    if (players.every(rater => rs.rankings[rater][0] === target)) unanimousFirst = target;
  });
  if (unanimousFirst) addScore(unanimousFirst, 1);
  rs.avgRank = avgRank;
  rs.roundedAvg = roundedAvg;
  rs.unanimousFirst = unanimousFirst;
}
function rankingNext() {
  transactionalCommit(() => {
    const rs = DB.roundState;
    rs.instanceIndex++;
    if (rs.instanceIndex >= rs.totalInstances) { advanceToNextRound(); return; }
    rankingStartInstance();
  });
}

// ============================================================
// ROUND — Secret Opinions
// ============================================================
function secretTotalInstances() { return playerIds().length <= 6 ? 4 : 3; }
function startSecretOpinions() {
  DB.roundState = {
    type: 'secretOpinions',
    totalInstances: secretTotalInstances(),
    instanceIndex: 0,
    usedTopic: [],
    usedPickAPlayer: [],
    phase: 'writing',
    mode: null,
    promptText: '',
    pendingAnswers: {},
    answers: {},
    revealOrder: [],
    currentRevealIndex: 0,
    guessedBy: {},
    currentGuesses: {},
    passResults: []
  };
  secretStartInstance();
}
function secretStartInstance() {
  const rs = DB.roundState;
  const useTopic = Math.random() < 0.6;
  rs.mode = useTopic ? 'topicOpinion' : 'pickAPlayer';
  rs.phase = 'writing';
  rs.pendingAnswers = {};
  rs.answers = {};
  rs.revealOrder = [];
  rs.currentRevealIndex = 0;
  rs.guessedBy = {};
  rs.currentGuesses = {};
  rs.passResults = [];
  if (useTopic) {
    const pool = CONTENT.secretOpinions.topicOpinion.filter(q => !rs.usedTopic.includes(q));
    rs.promptText = pool.length ? pick(pool) : pick(CONTENT.secretOpinions.topicOpinion);
    rs.usedTopic.push(rs.promptText);
  } else {
    const pool = CONTENT.secretOpinions.pickAPlayer.filter(q => !rs.usedPickAPlayer.includes(q));
    rs.promptText = pool.length ? pick(pool) : pick(CONTENT.secretOpinions.pickAPlayer);
    rs.usedPickAPlayer.push(rs.promptText);
  }
}
function secretSubmitAnswer(playerId, answer) {
  transactionalCommit(() => {
    const rs = DB.roundState;
    if (rs.phase !== 'writing') return;
    rs.pendingAnswers[playerId] = answer;
    if (Object.keys(rs.pendingAnswers).length >= playerIds().length) secretAdvanceToGuessing();
  });
}
function secretAdvanceToGuessing() {
  const rs = DB.roundState;
  rs.answers = { ...rs.pendingAnswers };
  rs.revealOrder = shuffle(Object.keys(rs.answers));
  rs.currentRevealIndex = 0;
  rs.currentGuesses = {};
  rs.phase = 'guessing';
}
function secretEligibleGuessers() {
  const rs = DB.roundState;
  const authorId = rs.revealOrder[rs.currentRevealIndex];
  return playerIds().filter(id => id !== authorId);
}
function secretAlreadyAccused(voterId, suspectId) {
  const rs = DB.roundState;
  return (rs.guessedBy[voterId] || []).includes(suspectId);
}
function secretSubmitGuess(voterId, suspectId) {
  transactionalCommit(() => {
    const rs = DB.roundState;
    if (rs.phase !== 'guessing') return;
    if (secretAlreadyAccused(voterId, suspectId)) return;   // can't re-accuse the same player this instance
    rs.currentGuesses[voterId] = suspectId;
    const eligible = secretEligibleGuessers();
    if (Object.keys(rs.currentGuesses).length >= eligible.length) secretCommitPass();
  });
}
function secretCommitPass() {
  const rs = DB.roundState;
  const authorId = rs.revealOrder[rs.currentRevealIndex];
  let correctCount = 0;
  const guesses = [];
  Object.entries(rs.currentGuesses).forEach(([voterId, suspectId]) => {
    rs.guessedBy[voterId] = (rs.guessedBy[voterId] || []).concat(suspectId);
    const correct = suspectId === authorId;
    if (correct) { addScore(voterId, 1); correctCount++; }
    guesses.push({ voterId, suspectId, correct });
  });
  const missedBy = Object.keys(rs.currentGuesses).length - correctCount;
  if (missedBy > 0) addScore(authorId, missedBy);
  rs.passResults.push({ authorId, answerText: rs.answers[authorId], guesses, correctCount, missedBy });
  rs.currentGuesses = {};
  rs.currentRevealIndex++;
  if (rs.currentRevealIndex >= rs.revealOrder.length) rs.phase = 'reveal';
}
function secretFinish() {
  transactionalCommit(() => {
    const rs = DB.roundState;
    rs.instanceIndex++;
    if (rs.instanceIndex >= rs.totalInstances) { advanceToNextRound(); return; }
    secretStartInstance();
  });
}

// ============================================================
// ROUND — Crystal Ball
// ============================================================
function crystalTotalTurns() {
  const n = playerIds().length;
  return n <= 5 ? n * 2 : n;
}
function startCrystalBall() {
  const n = playerIds().length;
  const perPlayer = n <= 5 ? 2 : 1;
  let order = [];
  for (let i = 0; i < perPlayer; i++) order = order.concat(shuffle(playerIds()));
  DB.roundState = {
    type: 'crystalBall',
    totalTurns: order.length,
    turnIndex: 0,
    subjectOrder: order,
    usedBinary: [],
    usedNumber: [],
    usedSingleWord: [],
    phase: 'choosing',
    subjectId: null,
    subType: null,
    promptText: '',
    optionA: null,
    optionB: null,
    min: null,
    max: null,
    subjectChoice: null,
    pendingGuesses: {},
    guesses: {}
  };
  crystalStartTurn();
}
function crystalDedupKey(subType, item) {
  if (subType === 'binary') return item.optionA + '|' + item.optionB;
  if (subType === 'number') return item.text;
  return item;   // singleWord items are already plain strings
}
function crystalStartTurn() {
  const rs = DB.roundState;
  rs.subjectId = rs.subjectOrder[rs.turnIndex];
  rs.phase = 'choosing';
  rs.subjectChoice = null;
  rs.pendingGuesses = {};
  rs.guesses = {};
  const subType = pick(['binary', 'number', 'singleWord']);
  rs.subType = subType;
  const pool = DB.meta.is18Plus ? CONTENT.crystalBall[subType].standard.concat(CONTENT.crystalBall[subType].adult) : CONTENT.crystalBall[subType].standard;
  const usedKey = subType === 'binary' ? 'usedBinary' : subType === 'number' ? 'usedNumber' : 'usedSingleWord';
  const remaining = pool.filter(q => !rs[usedKey].includes(crystalDedupKey(subType, q)));
  const chosen = remaining.length ? pick(remaining) : pick(pool);
  rs[usedKey].push(crystalDedupKey(subType, chosen));
  const subjectName = playerName(rs.subjectId);
  if (subType === 'binary') {
    rs.optionA = chosen.optionA;
    rs.optionB = chosen.optionB;
    rs.promptText = `${subjectName}: ${chosen.optionA} or ${chosen.optionB}?`;
  } else if (subType === 'number') {
    rs.min = chosen.min;
    rs.max = chosen.max;
    rs.promptText = chosen.text.replace(/\{Player\}/g, subjectName);
  } else {
    rs.promptText = chosen.replace(/\{Player\}/g, subjectName);
  }
}
function crystalSubmitChoice(playerId, choice) {
  transactionalCommit(() => {
    const rs = DB.roundState;
    if (rs.phase !== 'choosing' || playerId !== rs.subjectId) return;
    if (rs.subType === 'number' && (typeof choice !== 'number' || choice < rs.min || choice > rs.max)) return;
    rs.subjectChoice = choice;
    rs.phase = 'guessing';
  });
}
function crystalEligibleGuessers() { return playerIds().filter(id => id !== DB.roundState.subjectId); }
function crystalSubmitGuess(playerId, guess) {
  transactionalCommit(() => {
    const rs = DB.roundState;
    if (rs.phase !== 'guessing' || playerId === rs.subjectId) return;
    if (rs.subType === 'number' && (typeof guess !== 'number' || guess < rs.min || guess > rs.max)) return;
    rs.pendingGuesses[playerId] = guess;
    if (Object.keys(rs.pendingGuesses).length >= crystalEligibleGuessers().length) crystalReveal();
  });
}
function crystalReveal() {
  const rs = DB.roundState;
  rs.phase = 'reveal';
  rs.guesses = { ...rs.pendingGuesses };
  if (rs.subType === 'binary') {
    Object.entries(rs.guesses).forEach(([pid, g]) => { if (g === rs.subjectChoice) addScore(pid, 1); });
  } else if (rs.subType === 'number') {
    const entries = Object.entries(rs.guesses);
    if (entries.length) {
      let best = Infinity;
      entries.forEach(([pid, g]) => { const d = Math.abs(Number(g) - Number(rs.subjectChoice)); if (d < best) best = d; });
      entries.forEach(([pid, g]) => { if (Math.abs(Number(g) - Number(rs.subjectChoice)) === best) addScore(pid, 1); });
    }
  } else {
    Object.entries(rs.guesses).forEach(([pid, g]) => { if (wordsMatch(g, rs.subjectChoice)) addScore(pid, 1); });
  }
}
function crystalNext() {
  transactionalCommit(() => {
    const rs = DB.roundState;
    rs.turnIndex++;
    if (rs.turnIndex >= rs.totalTurns) { advanceToNextRound(); return; }
    crystalStartTurn();
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
  appEl.appendChild(h('div', { class: 'footer-note' }, `Room ${ROOM_CODE} · batch 2 test build · synced live over Firebase.`));
}

function renderRoomGate() {
  const wrap = h('div', { class: 'screen' });
  wrap.appendChild(h('div', { class: 'eyebrow' }, 'Batch 2 test build'));
  wrap.appendChild(h('h1', {}, 'Start or join a game'));
  wrap.appendChild(h('div', { class: 'card raised' }, [
    h('div', { style: 'font-weight:700;margin-bottom:6px;' }, 'Host a new game'),
    h('p', { class: 'muted' }, `Ranking Wars, Secret Opinions and Crystal Ball only. Creates a fresh 4-letter room code.`),
    h('button', { class: 'primary', onclick: async () => { await enterRoom(generateRoomCode(), true); } }, 'Create game')
  ]));
  const codeInput = h('input', { type: 'text', placeholder: 'e.g. ABCD', maxlength: '4', style: 'text-transform:uppercase;' });
  wrap.appendChild(h('div', { class: 'card raised' }, [
    h('div', { style: 'font-weight:700;margin-bottom:6px;' }, 'Join with a code'),
    h('label', { class: 'field' }, ['Room code', codeInput]),
    h('div', { style: 'height:10px' }),
    h('button', { class: 'secondary', onclick: async () => { const v = codeInput.value.trim().toUpperCase(); if (v.length === 4) await enterRoom(v, false); } }, 'Join game')
  ]));
  const lastRoom = localStorage.getItem('batch2_last_room');
  if (lastRoom) wrap.appendChild(h('button', { class: 'ghost', onclick: async () => { await enterRoom(lastRoom, false); } }, `Rejoin your last room (${lastRoom})`));
  return wrap;
}
function renderTopBar() {
  const bar = h('div', { class: 'device-bar' });
  bar.appendChild(h('div', { class: 'top-bar-lobby' }, [
    h('span', { class: 'code-badge' }, ROOM_CODE),
    h('span', { style: 'font-size:13px;color:var(--text-dim);' }, joined ? `You: ${playerName(viewingAs)}` : 'Not joined yet'),
    h('span', { style: 'cursor:pointer;text-decoration:underline;font-size:12px;color:var(--text-dim);', onclick: leaveRoom }, 'leave room')
  ]));
  return bar;
}
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
function renderLobby() {
  const wrap = document.createDocumentFragment();
  wrap.appendChild(h('div', { class: 'eyebrow' }, 'Lobby ' + ROOM_CODE));
  wrap.appendChild(h('h1', {}, 'Batch 2 test build'));
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
  controls.appendChild(h('div', { class: 'toggle-row' }, [
    h('div', {}, [h('strong', {}, '18+ content'), h('div', { class: 'muted' }, 'Off means every question stays standard-tier.')]),
    h('label', { class: 'switch' }, [
      (() => { const i = h('input', { type: 'checkbox' }); i.checked = DB.meta.is18Plus; i.disabled = !hostView; i.addEventListener('change', toggle18Plus); return i; })(),
      h('span', { class: 'track' })
    ])
  ]));
  wrap.appendChild(controls);
  const canBegin = n >= 4 && n <= 12;
  wrap.appendChild(h('button', { class: 'primary', onclick: beginSession, disabled: !(canBegin && hostView) }, canBegin ? 'Begin session' : `Need 4 to 12 players`));
  if (!hostView) wrap.appendChild(h('p', { class: 'muted' }, `Only the host (${playerName(DB.meta.hostId)}) can toggle 18+ or begin.`));
  return wrap;
}
function renderRound() {
  const type = DB.session.currentRound;
  if (type === 'rankingWars') return renderRankingWars();
  if (type === 'secretOpinions') return renderSecretOpinions();
  if (type === 'crystalBall') return renderCrystalBall();
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
  const t = h('textarea', {}); t.id = 'write-input';
  box.appendChild(h('label', { class: 'field' }, [label, t]));
  box.appendChild(h('div', { style: 'height:10px' }));
  box.appendChild(h('button', { class: 'primary', onclick: () => { const v = document.getElementById('write-input').value; if (v.trim()) onSubmit(v); } }, 'Submit'));
  return box;
}
function waitingBlock(text) { return h('div', { class: 'waiting' }, [h('div', { class: 'spinner' }), h('div', {}, text)]); }

// ---------------- Ranking Wars UI ----------------
function renderRankingWars() {
  const rs = DB.roundState;
  const wrap = document.createDocumentFragment();
  wrap.appendChild(roundBanner('Ranking Wars', `Round ${rs.instanceIndex + 1} / ${rs.totalInstances}`));
  wrap.appendChild(h('div', { class: 'card' }, [h('div', { class: 'prompt-text' }, rs.category)]));

  if (rs.phase === 'ranking') {
    if (rs.rankings[viewingAs]) {
      wrap.appendChild(waitingBlock(`Ranking locked in. Waiting on ${playerIds().length - Object.keys(rs.rankings).length} more...`));
    } else {
      wrap.appendChild(h('p', { class: 'muted' }, 'Tap players in order, best fit first. Tap again to undo.'));
      const myOrder = (renderRankingWars._draft && renderRankingWars._draft[viewingAs]) || [];
      const list = h('div', { class: 'option-grid' });
      playerIds().forEach(pid => {
        const idx = myOrder.indexOf(pid);
        const btn = h('button', {
          class: 'option-btn' + (idx >= 0 ? ' picked' : ''),
          onclick: () => {
            renderRankingWars._draft = renderRankingWars._draft || {};
            const arr = renderRankingWars._draft[viewingAs] || [];
            const pos = arr.indexOf(pid);
            if (pos >= 0) arr.splice(pos, 1); else arr.push(pid);
            renderRankingWars._draft[viewingAs] = arr;
            render();
          }
        }, [idx >= 0 ? h('span', { class: 'tag' }, `Rank ${idx + 1}`) : null, playerName(pid)]);
        list.appendChild(btn);
      });
      wrap.appendChild(list);
      const complete = myOrder.length === playerIds().length;
      wrap.appendChild(h('button', {
        class: 'primary', disabled: !complete,
        onclick: () => { rankingSubmit(viewingAs, myOrder); renderRankingWars._draft = {}; }
      }, complete ? 'Submit ranking' : `Rank everyone to submit (${myOrder.length}/${playerIds().length})`));
    }
  } else if (rs.phase === 'reveal') {
    const list = h('div', { class: 'player-list' });
    playerIds()
      .slice()
      .sort((a, b) => rs.roundedAvg[a] - rs.roundedAvg[b])
      .forEach(id => {
        list.appendChild(h('div', { class: 'player-row' }, [
          h('span', {}, playerName(id)),
          h('span', { class: 'muted' }, `avg rank ${rs.avgRank[id]} → rounds to ${rs.roundedAvg[id]}`)
        ]));
      });
    wrap.appendChild(h('div', { class: 'card' }, list));
    wrap.appendChild(h('div', { class: 'score-flash' }, `+1 to anyone whose placement of a player matched that player's rounded average.`));
    if (rs.unanimousFirst) wrap.appendChild(h('div', { class: 'score-flash' }, `+1 bonus to ${playerName(rs.unanimousFirst)}: everyone independently ranked them 1st.`));
    wrap.appendChild(h('button', { class: 'primary', onclick: rankingNext }, rs.instanceIndex + 1 >= rs.totalInstances ? 'Continue to next round' : 'Next category'));
  }
  return wrap;
}

// ---------------- Secret Opinions UI ----------------
function renderSecretOpinions() {
  const rs = DB.roundState;
  const wrap = document.createDocumentFragment();
  wrap.appendChild(roundBanner('Secret Opinions', `Round ${rs.instanceIndex + 1} / ${rs.totalInstances}`));
  wrap.appendChild(h('div', { class: 'card' }, [h('div', { class: 'prompt-text' }, rs.promptText)]));

  if (rs.phase === 'writing') {
    if (rs.pendingAnswers[viewingAs] !== undefined) {
      wrap.appendChild(waitingBlock(`Answer locked in. Waiting on ${playerIds().length - Object.keys(rs.pendingAnswers).length} more...`));
    } else if (rs.mode === 'pickAPlayer') {
      const grid = h('div', { class: 'option-grid' });
      playerIds().filter(id => id !== viewingAs).forEach(id => {
        grid.appendChild(h('button', { class: 'option-btn', onclick: () => secretSubmitAnswer(viewingAs, id) }, playerName(id)));
      });
      wrap.appendChild(h('p', { class: 'muted' }, 'Pick someone (not yourself).'));
      wrap.appendChild(grid);
    } else {
      wrap.appendChild(writeBox('Your honest answer.', (t) => secretSubmitAnswer(viewingAs, t)));
    }
  } else if (rs.phase === 'guessing') {
    const authorId = rs.revealOrder[rs.currentRevealIndex];
    const answerText = rs.mode === 'pickAPlayer' ? playerName(rs.answers[authorId]) : rs.answers[authorId];
    wrap.appendChild(h('div', { class: 'card raised' }, [
      h('span', { class: 'eyebrow' }, `Answer ${rs.currentRevealIndex + 1} of ${rs.revealOrder.length}`),
      h('div', { class: 'prompt-text', style: 'margin-top:6px;' }, answerText)
    ]));
    if (viewingAs === authorId) {
      wrap.appendChild(waitingBlock(`That one's yours — sit tight while the others guess.`));
    } else if (rs.currentGuesses[viewingAs] !== undefined) {
      wrap.appendChild(waitingBlock(`Guess locked in. Waiting on ${secretEligibleGuessers().length - Object.keys(rs.currentGuesses).length} more...`));
    } else {
      const grid = h('div', { class: 'option-grid' });
      playerIds().filter(id => id !== viewingAs).forEach(id => {
        const already = secretAlreadyAccused(viewingAs, id);
        grid.appendChild(h('button', { class: 'option-btn', disabled: already, onclick: () => secretSubmitGuess(viewingAs, id) }, [
          playerName(id), already ? h('span', { class: 'tag', style: 'display:block;' }, 'already guessed this round') : null
        ]));
      });
      wrap.appendChild(h('p', { class: 'muted' }, `Who wrote this? You can't accuse the same player twice this round.`));
      wrap.appendChild(grid);
    }
  } else if (rs.phase === 'reveal') {
    rs.passResults.forEach(pr => {
      const answerText = rs.mode === 'pickAPlayer' ? `picked ${playerName(pr.answerText)}` : `"${pr.answerText}"`;
      wrap.appendChild(h('div', { class: 'card raised' }, [
        h('span', { class: 'eyebrow' }, playerName(pr.authorId)),
        h('div', { style: 'margin:4px 0 8px;' }, answerText),
        h('div', { class: 'muted' }, `${pr.correctCount} correct guess${pr.correctCount === 1 ? '' : 'es'} · +${pr.missedBy} to ${playerName(pr.authorId)} for staying hidden from ${pr.missedBy}`)
      ]));
    });
    wrap.appendChild(h('button', { class: 'primary', onclick: secretFinish }, rs.instanceIndex + 1 >= rs.totalInstances ? 'Continue to next round' : 'Next prompt'));
  }
  return wrap;
}

// ---------------- Crystal Ball UI ----------------
function renderCrystalBall() {
  const rs = DB.roundState;
  const wrap = document.createDocumentFragment();
  wrap.appendChild(roundBanner('Crystal Ball', `Turn ${rs.turnIndex + 1} / ${rs.totalTurns}`));
  wrap.appendChild(h('div', { class: 'card' }, [h('div', { class: 'prompt-text' }, rs.promptText)]));

  if (rs.phase === 'choosing') {
    if (viewingAs !== rs.subjectId) {
      wrap.appendChild(waitingBlock(`Waiting on ${playerName(rs.subjectId)} to choose privately.`));
    } else if (rs.subType === 'binary') {
      wrap.appendChild(h('div', { class: 'option-grid' }, [
        h('button', { class: 'option-btn', onclick: () => crystalSubmitChoice(viewingAs, 'A') }, rs.optionA),
        h('button', { class: 'option-btn', onclick: () => crystalSubmitChoice(viewingAs, 'B') }, rs.optionB)
      ]));
    } else if (rs.subType === 'number') {
      const inp = h('input', { type: 'number', min: rs.min, max: rs.max, placeholder: `Between ${rs.min} and ${rs.max}` });
      const err = h('div', { class: 'muted', style: 'color:var(--coral);font-size:12px;min-height:16px;' });
      const btn = h('button', { class: 'primary', disabled: true, onclick: () => { const v = Number(inp.value); if (numberInRange(inp.value, rs.min, rs.max)) crystalSubmitChoice(viewingAs, v); } }, 'Submit');
      inp.addEventListener('input', () => {
        const ok = numberInRange(inp.value, rs.min, rs.max);
        btn.disabled = !ok;
        err.textContent = (!ok && inp.value !== '') ? `Must be between ${rs.min} and ${rs.max}.` : '';
      });
      wrap.appendChild(h('div', { class: 'card raised' }, [
        h('label', { class: 'field' }, [`Your honest number (${rs.min}–${rs.max})`, inp]),
        err,
        h('div', { style: 'height:6px' }),
        btn
      ]));
    } else {
      wrap.appendChild(writeBox('Your honest one word.', (t) => crystalSubmitChoice(viewingAs, t)));
    }
  } else if (rs.phase === 'guessing') {
    if (viewingAs === rs.subjectId) {
      wrap.appendChild(waitingBlock(`Everyone else is guessing what you picked.`));
    } else if (rs.pendingGuesses[viewingAs] !== undefined) {
      wrap.appendChild(waitingBlock(`Guess locked in. Waiting on ${crystalEligibleGuessers().length - Object.keys(rs.pendingGuesses).length} more...`));
    } else if (rs.subType === 'binary') {
      wrap.appendChild(h('div', { class: 'option-grid' }, [
        h('button', { class: 'option-btn', onclick: () => crystalSubmitGuess(viewingAs, 'A') }, rs.optionA),
        h('button', { class: 'option-btn', onclick: () => crystalSubmitGuess(viewingAs, 'B') }, rs.optionB)
      ]));
    } else if (rs.subType === 'number') {
      const inp = h('input', { type: 'number', min: rs.min, max: rs.max, placeholder: `Between ${rs.min} and ${rs.max}` });
      const err = h('div', { class: 'muted', style: 'color:var(--coral);font-size:12px;min-height:16px;' });
      const btn = h('button', { class: 'primary', disabled: true, onclick: () => { const v = Number(inp.value); if (numberInRange(inp.value, rs.min, rs.max)) crystalSubmitGuess(viewingAs, v); } }, 'Submit');
      inp.addEventListener('input', () => {
        const ok = numberInRange(inp.value, rs.min, rs.max);
        btn.disabled = !ok;
        err.textContent = (!ok && inp.value !== '') ? `Must be between ${rs.min} and ${rs.max}.` : '';
      });
      wrap.appendChild(h('div', { class: 'card raised' }, [
        h('label', { class: 'field' }, [`Your guess (${rs.min}–${rs.max})`, inp]),
        err,
        h('div', { style: 'height:6px' }),
        btn
      ]));
    } else {
      wrap.appendChild(writeBox('Your guess.', (t) => crystalSubmitGuess(viewingAs, t)));
    }
  } else if (rs.phase === 'reveal') {
    const actualLabel = rs.subType === 'binary' ? (rs.subjectChoice === 'A' ? rs.optionA : rs.optionB) : rs.subjectChoice;
    wrap.appendChild(h('div', { class: 'card raised' }, [
      h('span', { class: 'eyebrow' }, `${playerName(rs.subjectId)} actually picked`),
      h('div', { class: 'prompt-text', style: 'margin-top:6px;' }, String(actualLabel))
    ]));
    const list = h('div', { class: 'player-list' });
    Object.entries(rs.guesses).forEach(([pid, g]) => {
      const label = rs.subType === 'binary' ? (g === 'A' ? rs.optionA : rs.optionB) : String(g);
      const gotIt = rs.subType === 'binary' ? g === rs.subjectChoice : rs.subType === 'singleWord' ? wordsMatch(g, rs.subjectChoice) : null;
      list.appendChild(h('div', { class: 'player-row' }, [
        h('span', {}, playerName(pid)),
        h('span', {}, [label, gotIt ? h('span', { class: 'tag', style: 'color:var(--mint);margin-left:8px;' }, 'close enough ✓') : null])
      ]));
    });
    wrap.appendChild(h('div', { class: 'card' }, list));
    if (rs.subType === 'singleWord') wrap.appendChild(h('p', { class: 'muted' }, `Word guesses count if close: case, plurals and small typos don't matter.`));
    wrap.appendChild(h('button', { class: 'primary', onclick: crystalNext }, rs.turnIndex + 1 >= rs.totalTurns ? 'Continue to next round' : 'Next turn'));
  }
  return wrap;
}

// ---------------- Session end ----------------
const ROUND_DISPLAY_NAMES = { rankingWars: 'Ranking Wars', secretOpinions: 'Secret Opinions', crystalBall: 'Crystal Ball' };

function renderRoundSummary() {
  const wrap = document.createDocumentFragment();
  const summary = DB.session.lastRoundSummary;
  wrap.appendChild(h('div', { class: 'eyebrow' }, 'Round complete'));
  wrap.appendChild(h('h1', {}, ROUND_DISPLAY_NAMES[summary.roundType] || summary.roundType));
  const list = h('div', { class: 'player-list' });
  playerIds().slice().sort((a, b) => (summary.delta[b] || 0) - (summary.delta[a] || 0)).forEach(id => {
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
  wrap.appendChild(h('div', { class: 'card' }, [h('div', { class: 'eyebrow' }, 'This round · running total'), list]));
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
    list.appendChild(h('div', { class: 'player-row' }, [h('span', {}, `${i + 1}. ${playerName(id)}`), h('span', { class: 'score' }, String(DB.scoreboard[id] || 0))]));
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
