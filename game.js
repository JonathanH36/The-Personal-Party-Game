// ============================================================
// The Personal Party Game
// Every browser window with the room code is a genuinely separate
// player. State lives at /lobbies/{ROOM_CODE} in Realtime Database
// and is mirrored into the local DB object by a live onValue
// listener.
//
// Architecture, unchanged from the three test batches this was
// merged from:
//   1. Any write another player's device could be racing against
//      goes through transactionalCommit() (Firebase runTransaction),
//      never a plain set().
//   2. Every action handler checks the current phase first (phase
//      guard) and bails out silently if a late/duplicate click no
//      longer matches the expected phase.
//   3. normalizeDB() defensively rebuilds arrays/objects on every
//      snapshot, because Firebase silently drops empty objects,
//      empty arrays, and individual null values on write.
//   4. "Don't repeat this prompt" tracking is dedup-by-content
//      (a stable id or the prompt text itself), never by object
//      reference, because references don't survive a Firebase
//      round-trip through JSON.
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
const FIELD_SEQUENCE = [
  { key: 'maleName', prompt: "A man's name" },
  { key: 'femaleName', prompt: "A woman's name" },
  { key: 'whereMet', prompt: 'Where they met' },
  { key: 'heSaid', prompt: 'What he said to her' },
  { key: 'sheSaid', prompt: 'What she said to him' },
  { key: 'tenYears', prompt: 'Where they will be in 10 years' }
];
const TRIVIABLUFF_CATEGORY_OPTIONS = 4;
const SAYANYTHING_INSTANCES = 3;
const TRIVIABLUFF_INSTANCES = 5;
const IMPOSTER_INSTANCES = 2;
const ROUNDS_PER_SESSION = 4;

// All 9 round types. `personal: false` means the round has no
// personal content at all and drops out of the pool entirely when
// personal-only mode is on (currently just Trivia Bluff). Every other
// round either is inherently personal, or has a personal subset it
// falls back to.
const ROUND_INFO = {
  truthComesOut: { name: 'Truth Comes Out', personal: true },
  storyRound:    { name: 'Story Round', personal: true },
  splitTheRoom:  { name: 'Split the Room', personal: true },
  rankingWars:   { name: 'Ranking Wars', personal: true },
  sayAnything:   { name: 'SayAnything', personal: true },
  triviaBluff:   { name: 'Trivia Bluff', personal: false },
  secretOpinions:{ name: 'Secret Opinions', personal: true },
  crystalBall:   { name: 'Crystal Ball', personal: true },
  imposter:      { name: 'Imposter', personal: true }
};
const ROUND_TYPES = Object.keys(ROUND_INFO);
const ROUND_DISPLAY_NAMES = Object.fromEntries(ROUND_TYPES.map(t => [t, ROUND_INFO[t].name]));

function isRoundAvailable(type, meta) {
  if (ROUND_INFO[type].personal === false && meta.personalOnly) return false;
  return true;
}
// Which content tiers a round's prompt pool should draw from, given
// the host's three-way content setting. Rounds with no adult tier at
// all (Secret Opinions, Imposter, Story Round) just ignore this.
function contentTiersFor(meta) {
  if (meta.contentTier === 'adultOnly') return ['adult'];
  if (meta.contentTier === 'mixed') return ['standard', 'adult'];
  return ['standard'];
}

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
    meta: { hostId: null, status: 'lobby', contentTier: 'standard', personalOnly: false },
    players: {},
    scoreboard: {},
    session: { roundOrder: [], currentRoundIndex: -1, currentRound: null, selectedRounds: [] },
    roundState: null
  };
}

// Firebase drops empty objects/arrays entirely, so paths that were
// emptied come back as undefined. Patch them back to safe defaults
// after every snapshot.
function normalizeDB() {
  if (!DB) return;
  DB.meta = { hostId: null, status: 'lobby', contentTier: 'standard', personalOnly: false, ...(DB.meta || {}) };
  DB.players = DB.players || {};
  DB.scoreboard = DB.scoreboard || {};
  DB.session = DB.session || { roundOrder: [], currentRoundIndex: -1, currentRound: null, selectedRounds: [] };
  DB.session.selectedRounds = DB.session.selectedRounds || [];
  normalizeRoundState();
}

// Firebase drops empty objects/arrays entirely rather than storing
// them as {} or [], so any collection that starts empty comes back
// as `undefined` on every OTHER client's snapshot, not {} or []. Every
// round keeps at least one such collection, so this has to run for
// whichever round type is currently active, every time a snapshot
// lands.
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
    if (rs.stories) {
      Object.values(rs.stories).forEach(story => {
        const existing = story.fields || {};
        const restored = [];
        for (let i = 0; i < FIELD_SEQUENCE.length; i++) {
          restored.push(existing[i] !== undefined ? existing[i] : false);
        }
        story.fields = restored;
      });
    }
  } else if (rs.type === 'splitTheRoom') {
    rs.votes = rs.votes || {};
    rs.usedStandard = rs.usedStandard || [];
    rs.usedH2H = rs.usedH2H || [];
  } else if (rs.type === 'rankingWars') {
    rs.rankings = rs.rankings || {};
    rs.usedCategories = rs.usedCategories || [];
  } else if (rs.type === 'secretOpinions') {
    rs.pendingAnswers = rs.pendingAnswers || {};
    rs.answers = rs.answers || {};
    rs.revealOrder = rs.revealOrder || [];
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
    rs.judgeAnswers = rs.judgeAnswers || {};
    rs.judgeOrder = rs.judgeOrder || [];
  } else if (rs.type === 'sayAnything') {
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
    rs.votes = rs.votes || {};
    rs.usedCelebIds = rs.usedCelebIds || [];
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

function identityKey() { return 'ppg_identity_' + ROOM_CODE; }

async function enterRoom(code, isNewRoom) {
  await _authReady;
  ROOM_CODE = code;
  localStorage.setItem('ppg_last_room', code);
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
function setContentTier(tier) {
  transactionalCommit(() => {
    DB.meta.contentTier = tier;
    // an adult-only + personal-only combo can leave some rounds with
    // no valid content (e.g. Split the Room's head-to-head prompts
    // have no adult version) — that's resolved per-round by falling
    // back to whichever tier is actually available, not by blocking
    // the round, so no selection cleanup is needed here.
  });
}
function togglePersonalOnly() {
  transactionalCommit(() => {
    DB.meta.personalOnly = !DB.meta.personalOnly;
    DB.session.selectedRounds = DB.session.selectedRounds.filter(t => isRoundAvailable(t, DB.meta));
  });
}
function toggleRoundSelection(type) {
  transactionalCommit(() => {
    if (!isRoundAvailable(type, DB.meta)) return;
    const sel = DB.session.selectedRounds;
    const idx = sel.indexOf(type);
    if (idx >= 0) sel.splice(idx, 1);
    else if (sel.length < ROUNDS_PER_SESSION) sel.push(type);
  });
}
function randomiseRounds() {
  transactionalCommit(() => {
    const pool = ROUND_TYPES.filter(t => isRoundAvailable(t, DB.meta));
    DB.session.selectedRounds = sample(pool, Math.min(ROUNDS_PER_SESSION, pool.length));
  });
}

function beginSession() {
  const n = playerIds().length;
  if (n < 4 || n > 12) return;
  if (DB.session.selectedRounds.length !== ROUNDS_PER_SESSION) return;
  transactionalCommit(() => {
    DB.meta.status = 'in_round';
    DB.session.roundOrder = shuffle(DB.session.selectedRounds); // played in a fresh order each time, not host-visible ahead of time
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
  if (type === 'truthComesOut') startTruthComesOut();
  else if (type === 'storyRound') startStoryRound();
  else if (type === 'splitTheRoom') startSplitTheRoom();
  else if (type === 'rankingWars') startRankingWars();
  else if (type === 'secretOpinions') startSecretOpinions();
  else if (type === 'crystalBall') startCrystalBall();
  else if (type === 'sayAnything') startSayAnything();
  else if (type === 'triviaBluff') startTriviaBluff();
  else if (type === 'imposter') startImposter();
}
function continueFromRoundSummary(playerId) { transactionalCommit(() => { if (playerId !== DB.meta.hostId) return; if (DB.meta.status !== 'round_summary') return; startPendingRound(); }); }


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
  const bank = contentTiersFor(DB.meta).flatMap(t => CONTENT.truthComesOut[t] || []);
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
  const fakeFoolCounts = {};   // fake-answer author -> how many people their fake fooled
  Object.entries(rs.votes).forEach(([voterId, slotId]) => {
    if (slotId === correctSlot) { addScore(voterId, 1); correctCount++; }
    else {
      addScore(rs.subjectId, 0.5);
      const fakeAuthorId = rs.answers[slotId].authorId;
      addScore(fakeAuthorId, 0.5);
      fakeFoolCounts[fakeAuthorId] = (fakeFoolCounts[fakeAuthorId] || 0) + 1;
      fooledCount++;
    }
  });
  rs.correctSlot = correctSlot;
  rs.anyoneCorrect = correctCount > 0;
  rs.fooledCount = fooledCount;
  rs.fakeFoolCounts = fakeFoolCounts;
}
function truthNext(playerId) {
  transactionalCommit(() => {
    if (playerId !== DB.meta.hostId) return; // host-only navigation
    const rs = DB.roundState;
    if (!rs || rs.phase !== 'reveal') return; // already advanced by someone else's tap
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
  order.forEach((pid, i) => { stories['story_' + i] = { ownerId: pid, fields: new Array(FIELD_SEQUENCE.length).fill(false) }; });
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
function storyNextRead(playerId) {
  transactionalCommit(() => {
    if (playerId !== DB.meta.hostId) return; // host-only navigation
    const rs = DB.roundState;
    if (!rs || rs.phase !== 'reading') return; // already advanced by someone else's tap
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
function storyFinish(playerId) { transactionalCommit(() => { if (playerId !== DB.meta.hostId) return; if (!DB.roundState || DB.roundState.phase !== 'reveal') return; advanceToNextRound(); }); }
function storyFieldText(story, index) {
  const f = story.fields[index];
  return f ? f.value : '____';
}
function storyFullText(story) {
  return `${storyFieldText(story, 0)} met ${storyFieldText(story, 1)} at ${storyFieldText(story, 2)}. `
    + `He said: "${storyFieldText(story, 3)}." She said: "${storyFieldText(story, 4)}." `
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
  const useH2H = DB.meta.personalOnly ? canH2H : (canH2H && Math.random() < 0.3);
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
    const bank = contentTiersFor(DB.meta).flatMap(t => CONTENT.splitTheRoom[t] || []);
    const pool = bank.filter(q => !rs.usedStandard.includes(q.optionA + '|' + q.optionB));
    const q = pool.length ? pick(pool) : pick(bank);
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
function splitNext(playerId) {
  transactionalCommit(() => {
    if (playerId !== DB.meta.hostId) return; // host-only navigation
    const rs = DB.roundState;
    if (!rs || rs.phase !== 'reveal') return; // already advanced by someone else's tap
    rs.instanceIndex++;
    if (rs.instanceIndex >= rs.totalInstances) { advanceToNextRound(); return; }
    splitStartInstance();
  });
}


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
  const bank = contentTiersFor(DB.meta).flatMap(t => CONTENT.rankingWars[t] || []);
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
function rankingNext(playerId) {
  transactionalCommit(() => {
    if (playerId !== DB.meta.hostId) return; // host-only navigation
    const rs = DB.roundState;
    if (!rs || rs.phase !== 'reveal') return; // already advanced by someone else's tap
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
    currentGuesses: {},
    passResults: []
  };
  secretStartInstance();
}
function secretStartInstance() {
  const rs = DB.roundState;
  const useTopic = DB.meta.personalOnly ? false : Math.random() < 0.6;
  rs.mode = useTopic ? 'topicOpinion' : 'pickAPlayer';
  rs.phase = 'writing';
  rs.pendingAnswers = {};
  rs.answers = {};
  rs.revealOrder = [];
  rs.currentRevealIndex = 0;
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
// Multiple players can give the exact same answer (two people both
// pick "Zain", say). The old version revealed each author one at a
// time, so two identical-looking "who picked Zain" screens showed up
// back to back with nothing to tell them apart, and a guess used up
// against the wrong one just wasted it. Instead, every distinct
// answer value is revealed once, showing how many people gave it,
// and guessers pick that many names in one go.
function secretAdvanceToGuessing() {
  const rs = DB.roundState;
  rs.answers = { ...rs.pendingAnswers };
  const groups = {};
  Object.entries(rs.answers).forEach(([authorId, value]) => {
    const key = String(value);
    groups[key] = groups[key] || [];
    groups[key].push(authorId);
  });
  rs.groups = groups; // answer value -> [authorIds who gave that answer]
  rs.revealOrder = shuffle(Object.keys(groups));
  rs.currentRevealIndex = 0;
  rs.currentGuesses = {};
  rs.phase = 'guessing';
}
function secretCurrentGroupAuthors() {
  const rs = DB.roundState;
  const key = rs.revealOrder[rs.currentRevealIndex];
  return rs.groups[key];
}
function secretEligibleGuessers() {
  const authors = secretCurrentGroupAuthors();
  return playerIds().filter(id => !authors.includes(id));
}
// suspectIds must be an array with exactly one entry per author in
// this group (so a group of 2 needs a 2-name guess, not a 1-at-a-time
// guess), and no repeats within the same guess.
function secretSubmitGuess(voterId, suspectIds) {
  transactionalCommit(() => {
    const rs = DB.roundState;
    if (rs.phase !== 'guessing') return;
    const authors = secretCurrentGroupAuthors();
    if (!Array.isArray(suspectIds) || suspectIds.length !== authors.length) return;
    if (new Set(suspectIds).size !== suspectIds.length) return;
    rs.currentGuesses[voterId] = suspectIds;
    const eligible = secretEligibleGuessers();
    if (Object.keys(rs.currentGuesses).length >= eligible.length) secretCommitPass();
  });
}
function secretCommitPass() {
  const rs = DB.roundState;
  const key = rs.revealOrder[rs.currentRevealIndex];
  const authors = secretCurrentGroupAuthors();
  const totalGuessers = Object.keys(rs.currentGuesses).length;
  const perAuthor = authors.map(authorId => {
    let correctCount = 0;
    Object.values(rs.currentGuesses).forEach(suspectIds => { if (suspectIds.includes(authorId)) correctCount++; });
    const missedBy = totalGuessers - correctCount;
    if (missedBy > 0) addScore(authorId, missedBy);
    return { authorId, correctCount, missedBy };
  });
  // +1 to a guesser for each author in the group they correctly included
  Object.entries(rs.currentGuesses).forEach(([voterId, suspectIds]) => {
    const hits = suspectIds.filter(id => authors.includes(id)).length;
    if (hits > 0) addScore(voterId, hits);
  });
  rs.passResults.push({ value: key, authors, perAuthor, totalGuessers });
  rs.currentGuesses = {};
  rs.currentRevealIndex++;
  if (rs.currentRevealIndex >= rs.revealOrder.length) rs.phase = 'reveal';
}
function secretFinish(playerId) {
  transactionalCommit(() => {
    if (playerId !== DB.meta.hostId) return; // host-only navigation
    const rs = DB.roundState;
    if (!rs || rs.phase !== 'reveal') return; // already advanced by someone else's tap
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
  rs.subjectChoice = null;
  rs.pendingGuesses = {};
  rs.guesses = {};
  rs.judgeAnswers = {};
  rs.judgeOrder = [];
  rs.winnerId = null;
  const subType = pick(['binary', 'number', 'singleWord']);
  rs.subType = subType;
  const pool = contentTiersFor(DB.meta).flatMap(t => CONTENT.crystalBall[subType][t] || []);
  const usedKey = subType === 'binary' ? 'usedBinary' : subType === 'number' ? 'usedNumber' : 'usedSingleWord';
  const remaining = pool.filter(q => !rs[usedKey].includes(crystalDedupKey(subType, q)));
  const chosen = remaining.length ? pick(remaining) : pick(pool);
  rs[usedKey].push(crystalDedupKey(subType, chosen));
  const subjectName = playerName(rs.subjectId);
  if (subType === 'binary') {
    rs.optionA = chosen.optionA;
    rs.optionB = chosen.optionB;
    rs.promptText = chosen.rawText.replace(/\{Player\}/g, subjectName);
    rs.phase = 'choosing';
  } else if (subType === 'number') {
    rs.min = chosen.min;
    rs.max = chosen.max;
    rs.promptText = chosen.text.replace(/\{Player\}/g, subjectName);
    rs.phase = 'choosing';
  } else {
    // single-word: guessing an exact word is hard to score fairly, so
    // instead everyone else writes their own answer and the subject
    // picks their favourite, same spirit as SayAnything's judging.
    rs.promptText = chosen.replace(/\{Player\}/g, subjectName);
    rs.phase = 'writing';
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
// Single-word only: everyone but the subject writes their own answer.
function crystalSubmitJudgeAnswer(playerId, text) {
  if (!text.trim()) return;
  transactionalCommit(() => {
    const rs = DB.roundState;
    if (rs.phase !== 'writing' || playerId === rs.subjectId) return;
    rs.judgeAnswers[playerId] = text.trim();
    if (Object.keys(rs.judgeAnswers).length >= crystalEligibleGuessers().length) {
      rs.judgeOrder = shuffle(Object.keys(rs.judgeAnswers)); // anonymous order for judging
      rs.phase = 'judging';
    }
  });
}
// Single-word only: the subject picks their favourite from the
// anonymised list, names are revealed once they've picked, not before.
function crystalSubmitJudgePick(playerId, winnerAuthorId) {
  transactionalCommit(() => {
    const rs = DB.roundState;
    if (rs.phase !== 'judging' || playerId !== rs.subjectId) return;
    if (!rs.judgeAnswers[winnerAuthorId]) return;
    rs.winnerId = winnerAuthorId;
    addScore(winnerAuthorId, 1);
    rs.phase = 'reveal';
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
  }
}
function crystalNext(playerId) {
  transactionalCommit(() => {
    if (playerId !== DB.meta.hostId) return; // host-only navigation
    const rs = DB.roundState;
    if (!rs || rs.phase !== 'reveal') return; // already advanced by someone else's tap
    rs.turnIndex++;
    if (rs.turnIndex >= rs.totalTurns) { advanceToNextRound(); return; }
    crystalStartTurn();
  });
}


// ============================================================
// ROUND - SayAnything
// 3 instances per session. Everyone (including any named subject in
// a personalised prompt) writes their own answer to the same prompt.
// Anonymous reveal, everyone votes for funniest (not their own),
// +1 point per vote received.
// ============================================================
function sayAnythingPool() {
  const tiers = contentTiersFor(DB.meta).map(t => t === 'adult' ? '18plus' : t);
  let pool = tiers.flatMap(t => CONTENT.sayAnything[t]);
  if (DB.meta.personalOnly) pool = pool.filter(p => p.type === 'single' || p.type === 'double');
  return pool;
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
function sayAnythingNext(playerId) {
  transactionalCommit(() => {
    if (playerId !== DB.meta.hostId) return; // host-only navigation
    const rs = DB.roundState;
    if (!rs || rs.phase !== 'reveal') return; // already advanced by someone else's tap
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
  if (DB.meta.contentTier === 'adultOnly') return ['Adult Trivia'];
  if (DB.meta.contentTier === 'mixed') return [...names, 'Adult Trivia'];
  return names;
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
function triviaBluffNext(playerId) {
  transactionalCommit(() => {
    if (playerId !== DB.meta.hostId) return; // host-only navigation
    const rs = DB.roundState;
    if (!rs || rs.phase !== 'reveal') return; // already advanced by someone else's tap
    rs.instanceIndex++;
    if (rs.instanceIndex >= rs.totalInstances) { advanceToNextRound(); return; }
    triviaBluffStartInstance();
  });
}


// ============================================================
// ROUND - Imposter
// 2 instances per session, 4 to 12 players. Engine picks a
// celebrity/historical figure vs a real lobby player randomly each
// instance. One player is the imposter and sees only the word
// "IMPOSTER", no hint of any kind. A random starting player is
// marked so the group knows who kicks off the verbal clue-giving
// (passing to their left in real life, entirely off-app: no clue
// text, no per-player turn tracking, no timer). The host alone
// decides when the group is ready and taps through to voting,
// however many times round the table that took. Confirmed scoring:
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
    starterId: null,
    subjectMode: null,
    subjectName: null,
    votes: {}
  };
  imposterStartInstance();
}
function imposterStartInstance() {
  const rs = DB.roundState;
  const ids = playerIds();
  const imposterId = pick(ids);
  const starterId = pick(ids); // could be the imposter, purely random
  const subjectMode = Math.random() < 0.5 ? 'celebrity' : 'player';

  let subjectName;
  if (subjectMode === 'celebrity' || ids.length < 2) {
    const pool = imposterPool();
    const remaining = pool.filter(c => !rs.usedCelebIds.includes(c.id));
    const chosen = remaining.length ? pick(remaining) : pick(pool);
    rs.usedCelebIds.push(chosen.id);
    subjectName = chosen.name;
    rs.subjectMode = 'celebrity';
  } else {
    const candidates = ids.filter(id => id !== imposterId);
    subjectName = playerName(pick(candidates));
    rs.subjectMode = 'player';
  }

  rs.imposterId = imposterId;
  rs.starterId = starterId;
  rs.subjectName = subjectName;
  rs.votes = {};
  rs.phase = 'clues';
}
function imposterViewFor(playerId) {
  const rs = DB.roundState;
  if (playerId === rs.imposterId) return { isImposter: true };
  return { name: rs.subjectName };
}
// Host-only: ends the verbal clue-giving, however many passes round
// the table it took, and moves everyone on to voting.
function imposterStartVoting(playerId) {
  if (playerId !== DB.meta.hostId) return; // host only
  transactionalCommit(() => {
    const rs = DB.roundState;
    if (rs.phase !== 'clues') return; // phase already moved on, a late click, ignore
    rs.phase = 'voting';
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
function imposterNext(playerId) {
  transactionalCommit(() => {
    if (playerId !== DB.meta.hostId) return; // host-only navigation
    const rs = DB.roundState;
    if (!rs || rs.phase !== 'reveal') return; // already advanced by someone else's tap
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

// A snapshot from ANY player (someone else joining, submitting,
// voting) triggers this on every connected device, including
// whoever's mid-sentence in a text box. Rebuilding the DOM from
// scratch would normally blow away whatever they'd just typed and
// drop their cursor, forcing them to race the next snapshot. Instead,
// capture the focused input's value and cursor position first, and
// restore both onto the freshly-rebuilt element with the same id
// afterwards, so typing is never interrupted.
function render() {
  const active = document.activeElement;
  let focusInfo = null;
  if (active && active.id && appEl.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    focusInfo = { id: active.id, value: active.value, selStart: active.selectionStart, selEnd: active.selectionEnd };
  }

  appEl.innerHTML = '';
  if (!ROOM_CODE) { appEl.appendChild(renderRoomGate()); restoreFocus(focusInfo); return; }
  appEl.appendChild(renderTopBar());
  const screen = h('div', { class: 'screen' });
  if (!joined) screen.appendChild(renderJoinForm());
  else if (DB.meta.status === 'lobby') screen.appendChild(renderLobby());
  else if (DB.meta.status === 'in_round') screen.appendChild(renderRound());
  else if (DB.meta.status === 'round_summary') screen.appendChild(renderRoundSummary());
  else if (DB.meta.status === 'session_end') screen.appendChild(renderSessionEnd());
  appEl.appendChild(screen);
  restoreFocus(focusInfo);
}
function restoreFocus(focusInfo) {
  if (!focusInfo) return;
  const el = document.getElementById(focusInfo.id);
  if (!el) return;
  el.value = focusInfo.value;
  el.focus();
  try { el.setSelectionRange(focusInfo.selStart, focusInfo.selEnd); } catch (e) { /* not all input types support this */ }
}

function renderRoomGate() {
  const wrap = h('div', { class: 'screen' });
  wrap.appendChild(h('div', { class: 'eyebrow' }, 'PPG'));
  wrap.appendChild(h('h1', {}, 'Start or join a game'));
  wrap.appendChild(h('div', { class: 'card raised' }, [
    h('div', { style: 'font-weight:700;margin-bottom:6px;' }, 'Host a new game'),
    h('p', { class: 'muted' }, `Creates a fresh 4-letter room code. Share it with everyone else so they can join on their own phone.`),
    h('button', { class: 'primary', onclick: async () => { await enterRoom(generateRoomCode(), true); } }, 'Create game')
  ]));
  const codeInput = h('input', { type: 'text', id: 'room-code-input', placeholder: 'e.g. ABCD', maxlength: '4', style: 'text-transform:uppercase;' });
  wrap.appendChild(h('div', { class: 'card raised' }, [
    h('div', { style: 'font-weight:700;margin-bottom:6px;' }, 'Join with a code'),
    h('label', { class: 'field' }, ['Room code', codeInput]),
    h('div', { style: 'height:10px' }),
    h('button', { class: 'secondary', onclick: async () => { const v = codeInput.value.trim().toUpperCase(); if (v.length === 4) await enterRoom(v, false); } }, 'Join game')
  ]));
  const lastRoom = localStorage.getItem('ppg_last_room');
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
  const nameInput = h('input', { type: 'text', id: 'join-name-input', placeholder: 'Your name' });
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
  wrap.appendChild(h('h1', {}, 'The Personal Party Game'));
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

  // ---- content controls ----
  const controls = h('div', { class: 'card' });
  controls.appendChild(h('div', { class: 'eyebrow' }, 'Host controls'));

  const tierRow = h('div', { style: 'margin-bottom:14px;' });
  tierRow.appendChild(h('strong', {}, 'Content'));
  const tierGrid = h('div', { class: 'option-grid', style: 'margin-top:8px;' });
  const tiers = [['standard', 'Standard only'], ['mixed', 'Standard + adult'], ['adultOnly', 'Adult only']];
  tiers.forEach(([key, label]) => {
    tierGrid.appendChild(h('button', {
      class: 'option-btn' + (DB.meta.contentTier === key ? ' picked' : ''),
      disabled: !hostView,
      onclick: () => setContentTier(key)
    }, label));
  });
  tierRow.appendChild(tierGrid);
  tierRow.appendChild(h('p', { class: 'muted', style: 'margin-top:6px;' }, 'Adult only draws just the adult tier wherever a round has one; rounds without adult content still play normally.'));
  controls.appendChild(tierRow);

  const personalRow = h('div', { class: 'toggle-row' }, [
    h('div', {}, [h('strong', {}, 'Personal only'), h('div', { class: 'muted' }, 'Restricts to rounds and prompts about people actually in this lobby.')]),
    h('label', { class: 'switch' }, [
      (() => { const i = h('input', { type: 'checkbox' }); i.checked = DB.meta.personalOnly; i.disabled = !hostView; i.addEventListener('change', togglePersonalOnly); return i; })(),
      h('span', { class: 'track' })
    ])
  ]);
  controls.appendChild(personalRow);
  wrap.appendChild(controls);

  // ---- round picker ----
  const picker = h('div', { class: 'card' });
  const sel = DB.session.selectedRounds;
  picker.appendChild(h('div', { class: 'eyebrow' }, `Rounds — ${sel.length} / ${ROUNDS_PER_SESSION} chosen`));
  const roundGrid = h('div', { class: 'option-grid' });
  ROUND_TYPES.forEach(type => {
    const available = isRoundAvailable(type, DB.meta);
    const picked = sel.includes(type);
    const disabled = !hostView || !available || (!picked && sel.length >= ROUNDS_PER_SESSION);
    roundGrid.appendChild(h('button', {
      class: 'option-btn' + (picked ? ' picked' : ''),
      disabled,
      onclick: () => toggleRoundSelection(type)
    }, [ROUND_DISPLAY_NAMES[type], !available ? h('span', { class: 'tag', style: 'display:block;' }, 'not personal') : null]));
  });
  picker.appendChild(roundGrid);
  if (hostView) {
    picker.appendChild(h('button', { class: 'secondary', style: 'margin-top:10px;', onclick: randomiseRounds }, 'Randomise for me'));
  }
  wrap.appendChild(picker);

  const canBegin = n >= 4 && n <= 12 && sel.length === ROUNDS_PER_SESSION;
  const label = n < 4 || n > 12 ? 'Need 4 to 12 players' : sel.length !== ROUNDS_PER_SESSION ? `Pick ${ROUNDS_PER_SESSION} rounds to begin` : 'Begin session';
  wrap.appendChild(h('button', { class: 'primary', onclick: beginSession, disabled: !(canBegin && hostView) }, label));
  if (!hostView) wrap.appendChild(h('p', { class: 'muted' }, `Only the host (${playerName(DB.meta.hostId)}) can change settings, pick rounds, or begin.`));
  return wrap;
}
function renderRound() {
  const type = DB.session.currentRound;
  if (type === 'truthComesOut') return renderTruthComesOut();
  if (type === 'storyRound') return renderStoryRound();
  if (type === 'splitTheRoom') return renderSplitTheRoom();
  if (type === 'rankingWars') return renderRankingWars();
  if (type === 'secretOpinions') return renderSecretOpinions();
  if (type === 'crystalBall') return renderCrystalBall();
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
  const t = h('textarea', {}); t.id = 'write-input';
  box.appendChild(h('label', { class: 'field' }, [label, t]));
  box.appendChild(h('div', { style: 'height:10px' }));
  box.appendChild(h('button', { class: 'primary', onclick: () => { const v = document.getElementById('write-input').value; if (v.trim()) onSubmit(v); } }, 'Submit'));
  return box;
}
function waitingBlock(text) { return h('div', { class: 'waiting' }, [h('div', { class: 'spinner' }), h('div', {}, text)]); }
// A "move everyone to the next screen" button, restricted to the
// host. Individual actions (writing, voting, picking) stay open to
// whichever player they belong to, this is only for pure navigation,
// which used to be tappable by anyone and caused rounds to skip
// ahead when several people tapped "Next" at once.
function nextButton(label, onNext) {
  if (viewingAs === DB.meta.hostId) {
    return h('button', { class: 'primary', onclick: () => onNext(viewingAs) }, label);
  }
  return waitingBlock(`Waiting for ${playerName(DB.meta.hostId)} to continue.`);
}


// ---------------- Truth Comes Out UI ----------------
function renderTruthComesOut() {
  const rs = DB.roundState;
  const wrap = document.createDocumentFragment();
  wrap.appendChild(roundBanner('Truth Comes Out', `Turn ${rs.turnIndex + 1} / ${rs.totalTurns}`));
  const subjectName = playerName(rs.subjectId);
  const combined = subjectName + ', ' + rs.questionText.charAt(0).toLowerCase() + rs.questionText.slice(1);
  wrap.appendChild(h('div', { class: 'card' }, [
    h('div', { class: 'prompt-text' }, combined)
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
      wrap.appendChild(waitingBlock(`Sit tight: everyone else is voting on which answer is really yours.`));
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
        h('div', { class: 'author' }, `Written by ${playerName(a.authorId)}${slotId === rs.correctSlot ? ': the real answer' : ''} · ${votesFor} vote${votesFor === 1 ? '' : 's'}`)
      ]));
    });
    wrap.appendChild(grid);
    const scoreLines = [];
    if (rs.anyoneCorrect) scoreLines.push(h('div', { class: 'score-flash' }, `+1 to everyone who found ${playerName(rs.subjectId)}'s real answer.`));
    if (rs.fooledCount > 0) scoreLines.push(h('div', { class: 'score-flash' }, `+${rs.fooledCount * 0.5} to ${playerName(rs.subjectId)}: half a point for each of the ${rs.fooledCount} player${rs.fooledCount === 1 ? '' : 's'} fooled.`));
    Object.entries(rs.fakeFoolCounts || {}).forEach(([authorId, count]) => {
      scoreLines.push(h('div', { class: 'score-flash' }, `+${count * 0.5} to ${playerName(authorId)}: their fake answer fooled ${count} player${count === 1 ? '' : 's'}.`));
    });
    scoreLines.forEach(l => wrap.appendChild(l));
    wrap.appendChild(nextButton(rs.turnIndex + 1 >= rs.totalTurns ? 'Continue to next round' : 'Next turn', truthNext));
  }
  return wrap;
}


// ---------------- Story Round UI ----------------
function renderStoryRound() {
  const rs = DB.roundState;
  const wrap = document.createDocumentFragment();
  wrap.appendChild(roundBanner('Story Round', rs.phase === 'writing' ? `Field ${rs.passIndex + 1} / ${FIELD_SEQUENCE.length}` : ''));

  if (rs.phase === 'writing') {
    const field = FIELD_SEQUENCE[rs.passIndex];
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
    wrap.appendChild(nextButton(rs.currentReadIndex + 1 >= keys.length ? 'All read: start voting' : 'Next story', storyNextRead));
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
        h('span', { class: 'eyebrow' }, `Winner, read by ${playerName(rs.readerAssignment[key])} · ${rs.tally[key]} vote${rs.tally[key] === 1 ? '' : 's'}`),
        h('div', { class: 'story-read', style: 'margin-top:8px;' }, storyFullText(rs.stories[key]))
      ]));
    });
    const pts = rs.winners.length > 1 ? 0.5 : 1;
    const contributionCounts = {};
    rs.winners.forEach(key => rs.stories[key].fields.forEach(f => { if (f) contributionCounts[f.contributorId] = (contributionCounts[f.contributorId] || 0) + 1; }));
    const breakdown = Object.entries(contributionCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => `${playerName(id)} +${(pts * count).toFixed(pts * count % 1 === 0 ? 0 : 1)} (${count} line${count === 1 ? '' : 's'})`)
      .join(', ');
    wrap.appendChild(h('div', { class: 'score-flash' }, breakdown));
    wrap.appendChild(nextButton('Continue to next round', storyFinish));
  }
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
        wrap.appendChild(h('div', { class: 'score-flash negative' }, `Dead split: everyone loses a point.`));
      } else {
        const majLabel = rs.tally.A > rs.tally.B ? labelA : labelB;
        wrap.appendChild(h('div', { class: 'score-flash' }, `+1 to everyone who backed "${majLabel}".`));
      }
    } else {
      if (rs.tally.A === rs.tally.B) {
        wrap.appendChild(h('div', { class: 'score-flash' }, `Tied: ${playerName(rs.current.playerA)} and ${playerName(rs.current.playerB)} split half a point each.`));
      } else {
        const winnerId = rs.tally.A > rs.tally.B ? rs.current.playerA : rs.current.playerB;
        wrap.appendChild(h('div', { class: 'score-flash' }, `+1 to ${playerName(winnerId)} for winning the majority, plus everyone who backed them.`));
      }
    }
    wrap.appendChild(nextButton(rs.instanceIndex + 1 >= rs.totalInstances ? 'Continue to next round' : 'Next prompt', splitNext));
  }
  return wrap;
}


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
    wrap.appendChild(nextButton(rs.instanceIndex + 1 >= rs.totalInstances ? 'Continue to next round' : 'Next category', rankingNext));
  }
  return wrap;
}


// ---------------- Secret Opinions UI ----------------
// Tracks the in-progress multi-select for the current group reveal
// locally, not in Firebase, since it's only meaningful until this
// player submits. Plain JS state survives a render() rebuild fine
// (it's not DOM), it just resets whenever the reveal moves to a new
// group.
let secretSelectionState = { revealIndex: -1, selected: [] };
function secretGetSelection(rs) {
  if (secretSelectionState.revealIndex !== rs.currentRevealIndex) {
    secretSelectionState = { revealIndex: rs.currentRevealIndex, selected: [] };
  }
  return secretSelectionState.selected;
}
function secretToggleSelection(id, need) {
  const sel = secretSelectionState.selected;
  const idx = sel.indexOf(id);
  if (idx >= 0) sel.splice(idx, 1);
  else if (sel.length < need) sel.push(id);
  render();
}
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
    const authors = secretCurrentGroupAuthors();
    const value = rs.revealOrder[rs.currentRevealIndex];
    const answerText = rs.mode === 'pickAPlayer' ? playerName(value) : value;
    const need = authors.length;
    wrap.appendChild(h('div', { class: 'card raised' }, [
      h('span', { class: 'eyebrow' }, `Answer ${rs.currentRevealIndex + 1} of ${rs.revealOrder.length}`),
      h('div', { class: 'prompt-text', style: 'margin-top:6px;' }, answerText),
      h('div', { class: 'muted', style: 'margin-top:4px;' }, need === 1 ? '1 person gave this answer.' : `${need} people gave this answer — pick all ${need}.`)
    ]));
    if (authors.includes(viewingAs)) {
      wrap.appendChild(waitingBlock(`That one's yours — sit tight while the others guess.`));
    } else if (rs.currentGuesses[viewingAs] !== undefined) {
      wrap.appendChild(waitingBlock(`Guess locked in. Waiting on ${secretEligibleGuessers().length - Object.keys(rs.currentGuesses).length} more...`));
    } else {
      const sel = secretGetSelection(rs);
      const grid = h('div', { class: 'option-grid' });
      playerIds().filter(id => id !== viewingAs).forEach(id => {
        const picked = sel.includes(id);
        grid.appendChild(h('button', {
          class: 'option-btn' + (picked ? ' picked' : ''),
          disabled: !picked && sel.length >= need,
          onclick: () => secretToggleSelection(id, need)
        }, playerName(id)));
      });
      wrap.appendChild(h('p', { class: 'muted' }, `Who gave this answer? Selected ${sel.length} of ${need}.`));
      wrap.appendChild(grid);
      wrap.appendChild(h('button', {
        class: 'primary', disabled: sel.length !== need,
        onclick: () => secretSubmitGuess(viewingAs, sel.slice())
      }, 'Submit guess'));
    }
  } else if (rs.phase === 'reveal') {
    rs.passResults.forEach(pr => {
      const answerText = rs.mode === 'pickAPlayer' ? `picked ${playerName(pr.value)}` : `"${pr.value}"`;
      const authorLines = pr.perAuthor.map(a => h('div', { class: 'muted' },
        `${playerName(a.authorId)}: ${a.correctCount} of ${pr.totalGuessers} guessed them (+${a.missedBy} to ${playerName(a.authorId)} for staying hidden from ${a.missedBy})`
      ));
      wrap.appendChild(h('div', { class: 'card raised' }, [
        h('span', { class: 'eyebrow' }, pr.authors.map(playerName).join(', ')),
        h('div', { style: 'margin:4px 0 8px;' }, answerText),
        ...authorLines
      ]));
    });
    wrap.appendChild(nextButton(rs.instanceIndex + 1 >= rs.totalInstances ? 'Continue to next round' : 'Next prompt', secretFinish));
  }
  return wrap;
}


// ---------------- Crystal Ball UI ----------------
function renderCrystalBall() {
  const rs = DB.roundState;
  const wrap = document.createDocumentFragment();
  wrap.appendChild(roundBanner('Crystal Ball', `Turn ${rs.turnIndex + 1} / ${rs.totalTurns}`));
  wrap.appendChild(h('div', { class: 'card' }, [h('div', { class: 'prompt-text' }, rs.promptText)]));

  if (rs.subType === 'singleWord') { renderCrystalBallSingleWord(rs, wrap); return wrap; }

  if (rs.phase === 'choosing') {
    if (viewingAs !== rs.subjectId) {
      wrap.appendChild(waitingBlock(`Waiting on ${playerName(rs.subjectId)} to choose privately.`));
    } else if (rs.subType === 'binary') {
      wrap.appendChild(h('div', { class: 'option-grid' }, [
        h('button', { class: 'option-btn', onclick: () => crystalSubmitChoice(viewingAs, 'A') }, rs.optionA),
        h('button', { class: 'option-btn', onclick: () => crystalSubmitChoice(viewingAs, 'B') }, rs.optionB)
      ]));
    } else {
      const inp = h('input', { type: 'number', id: 'write-input', min: rs.min, max: rs.max, placeholder: `Between ${rs.min} and ${rs.max}` });
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
    } else {
      const inp = h('input', { type: 'number', id: 'write-input', min: rs.min, max: rs.max, placeholder: `Between ${rs.min} and ${rs.max}` });
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
      const gotIt = rs.subType === 'binary' ? g === rs.subjectChoice : null;
      list.appendChild(h('div', { class: 'player-row' }, [
        h('span', {}, playerName(pid)),
        h('span', {}, [label, gotIt ? h('span', { class: 'tag', style: 'color:var(--mint);margin-left:8px;' }, 'close enough ✓') : null])
      ]));
    });
    wrap.appendChild(h('div', { class: 'card' }, list));
    wrap.appendChild(nextButton(rs.turnIndex + 1 >= rs.totalTurns ? 'Continue to next round' : 'Next turn', crystalNext));
  }
  return wrap;
}
// Single-word only: everyone but the subject writes an answer, the
// subject picks their favourite from an anonymised list, and the
// winner (revealed once picked) gets the point. Kept as a separate
// function since its phases don't overlap with binary/number at all.
function renderCrystalBallSingleWord(rs, wrap) {
  if (rs.phase === 'writing') {
    if (viewingAs === rs.subjectId) {
      wrap.appendChild(waitingBlock(`Everyone else is writing an answer for you to judge.`));
    } else if (rs.judgeAnswers[viewingAs] !== undefined) {
      wrap.appendChild(waitingBlock(`Answer locked in. Waiting on ${crystalEligibleGuessers().length - Object.keys(rs.judgeAnswers).length} more...`));
    } else {
      wrap.appendChild(writeBox(`Write your answer for ${playerName(rs.subjectId)} to judge.`, (t) => crystalSubmitJudgeAnswer(viewingAs, t)));
    }
  } else if (rs.phase === 'judging') {
    if (viewingAs !== rs.subjectId) {
      wrap.appendChild(waitingBlock(`Waiting on ${playerName(rs.subjectId)} to pick their favourite.`));
    } else {
      wrap.appendChild(h('p', { class: 'muted' }, 'Pick the one you like best. Anonymous for now, whoever wrote it gets the point once you choose.'));
      const grid = h('div', { class: 'option-grid' });
      rs.judgeOrder.forEach(authorId => {
        grid.appendChild(h('button', { class: 'option-btn', onclick: () => crystalSubmitJudgePick(viewingAs, authorId) }, rs.judgeAnswers[authorId]));
      });
      wrap.appendChild(grid);
    }
  } else if (rs.phase === 'reveal') {
    wrap.appendChild(h('div', { class: 'card raised' }, [
      h('span', { class: 'eyebrow' }, `${playerName(rs.subjectId)} picked`),
      h('div', { class: 'prompt-text', style: 'margin-top:6px;' }, rs.judgeAnswers[rs.winnerId]),
      h('div', { class: 'muted', style: 'margin-top:4px;' }, `Written by ${playerName(rs.winnerId)} — +1 point`)
    ]));
    const list = h('div', { class: 'player-list' });
    rs.judgeOrder.filter(id => id !== rs.winnerId).forEach(authorId => {
      list.appendChild(h('div', { class: 'player-row' }, [h('span', {}, playerName(authorId)), h('span', {}, rs.judgeAnswers[authorId])]));
    });
    if (rs.judgeOrder.length > 1) wrap.appendChild(h('div', { class: 'card' }, [h('div', { class: 'eyebrow' }, 'Everyone else wrote'), list]));
    wrap.appendChild(nextButton(rs.turnIndex + 1 >= rs.totalTurns ? 'Continue to next round' : 'Next turn', crystalNext));
  }
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
    wrap.appendChild(nextButton(rs.instanceIndex + 1 >= rs.totalInstances ? 'Continue to next round' : 'Next prompt', sayAnythingNext));
  }
  return wrap;
}


// ---------------- Trivia Bluff UI ----------------
// Writing the real answer as your "fake" is rejected server-side too,
// but silently, so this checks client-side first and explains why,
// rather than leaving the submit button looking like it did nothing.
function renderTriviaBluffWriteBox(rs) {
  const box = h('div', { class: 'card raised' });
  const t = h('textarea', {}); t.id = 'write-input';
  const err = h('div', { class: 'muted', style: 'color:var(--coral);font-size:12px;min-height:16px;' });
  box.appendChild(h('label', { class: 'field' }, ['Write a convincing fake answer.', t]));
  box.appendChild(err);
  box.appendChild(h('div', { style: 'height:6px' }));
  box.appendChild(h('button', {
    class: 'primary', onclick: () => {
      const v = t.value.trim();
      if (!v) return;
      if (v.toLowerCase() === rs.question.a.trim().toLowerCase()) {
        err.textContent = "That's the real answer! Write a convincing fake one instead.";
        return;
      }
      triviaBluffSubmitFake(viewingAs, v);
    }
  }, 'Submit'));
  return box;
}
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
      wrap.appendChild(renderTriviaBluffWriteBox(rs));
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
    wrap.appendChild(nextButton(rs.instanceIndex + 1 >= rs.totalInstances ? 'Continue to next round' : 'Next question', triviaBluffNext));
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
    h('div', { class: 'prompt-text' }, view.name ? view.name : 'IMPOSTER')
  ]));

  if (rs.phase === 'clues') {
    if (viewingAs === rs.starterId) {
      wrap.appendChild(h('div', { class: 'score-flash' }, `You start! Say something about them out loud, then pass to your left.`));
    } else {
      wrap.appendChild(h('p', { class: 'muted' }, `${playerName(rs.starterId)} starts. Take it in turns saying something about them out loud, going round to the left.`));
    }
    const hostView = viewingAs === DB.meta.hostId;
    if (hostView) {
      wrap.appendChild(h('button', { class: 'primary', onclick: () => imposterStartVoting(viewingAs) }, 'Everyone ready: start voting'));
    } else {
      wrap.appendChild(waitingBlock(`Waiting for ${playerName(DB.meta.hostId)} to open voting.`));
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
    wrap.appendChild(nextButton(rs.instanceIndex + 1 >= rs.totalInstances ? 'Continue to next round' : 'Next imposter', imposterNext));
  }
  return wrap;
}


// ---------------- Session end ----------------
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
  wrap.appendChild(nextButton(DB.session.currentRoundIndex + 1 >= DB.session.roundOrder.length ? 'See final scoreboard' : 'Continue', continueFromRoundSummary));
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
