// ============================================================
// Party Game — Batch 3 test build
// Same Firebase-transaction architecture as the main build and batch 2.
// This file only wires up SayAnything, Trivia Bluff and Imposter, so it
// can be tested standalone without touching the six already-working
// rounds. Merge later = copy the round engine + render functions below
// into the main game.js and add these three type strings to its
// ROUND_TYPES list.
//
// Architecture rules carried over from the main build:
//   1. Any write another player's device could be racing against goes
//      through transactionalCommit() (Firebase runTransaction), never a
//      plain set().
//   2. Every action handler checks the current phase first (phase
//      guard) and bails out silently if a late/duplicate click no
//      longer matches the expected phase.
//   3. normaliseDB() defensively rebuilds arrays/objects on every
//      snapshot, because Firebase silently drops empty objects, empty
//      arrays, and individual null values on write.
//   4. "Don't repeat this prompt" tracking is dedup-by-content (the
//      prompt's stable id, stored in a used-ids array), never by
//      object reference, because references don't survive a Firebase
//      round-trip through JSON.
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, onValue, set, runTransaction, get
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import {
  getAuth, signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// ---- Firebase config: paste the same config used in the main build
// and batch2 (same project, "the-personal-party-game") ----
const firebaseConfig = {
  apiKey: "PASTE_ME",
  authDomain: "the-personal-party-game.firebaseapp.com",
  databaseURL: "https://the-personal-party-game-default-rtdb.firebaseio.com",
  projectId: "the-personal-party-game",
  storageBucket: "the-personal-party-game.appspot.com",
  messagingSenderId: "PASTE_ME",
  appId: "PASTE_ME"
};

let fbApp, fbDB, fbAuth, roomRef;
let LOCAL_UID = null;

function initFirebase(roomCode) {
  fbApp = initializeApp(firebaseConfig);
  fbDB = getDatabase(fbApp);
  fbAuth = getAuth(fbApp);
  roomRef = ref(fbDB, `rooms/${roomCode}`);
  signInAnonymously(fbAuth).catch((err) => console.error('Firebase auth error:', err));
  onValue(roomRef, (snap) => {
    DB = normaliseDB(snap.val());
    render();
  });
}

// ============================================================
// Shared state shape + normalisation
// ============================================================

let DB = null;
const ROUND_TYPES = ['sayAnything', 'triviaBluff', 'imposter'];

function freshDB() {
  return {
    meta: { status: 'lobby', createdAt: Date.now(), adultMode: false },
    players: {},
    session: {
      roundOrder: [],
      currentRoundIndex: -1,
      currentRound: null,
      usedPromptIds: {},     // { sayAnything: [ids], triviaBluff: [ids], imposter: [ids] }
      scores: {}
    },
    roundState: null
  };
}

// Firebase silently drops empty objects/arrays and individual `null`
// values on write. Every snapshot gets rebuilt defensively so the rest
// of the engine can assume these shapes always exist.
function normaliseDB(raw) {
  if (!raw) return freshDB();
  const db = { ...freshDB(), ...raw };
  db.meta = { ...freshDB().meta, ...(raw.meta || {}) };
  db.players = raw.players || {};
  db.session = { ...freshDB().session, ...(raw.session || {}) };
  db.session.usedPromptIds = { sayAnything: [], triviaBluff: [], imposter: [], ...(raw.session && raw.session.usedPromptIds || {}) };
  ROUND_TYPES.forEach(t => {
    if (!Array.isArray(db.session.usedPromptIds[t])) db.session.usedPromptIds[t] = [];
  });
  db.session.scores = raw.session && raw.session.scores || {};
  db.roundState = raw.roundState || null;
  if (db.roundState) {
    // defensive rebuild of anything that can legitimately be empty
    db.roundState.answers = db.roundState.answers || {};
    db.roundState.votes = db.roundState.votes || {};
    db.roundState.fakeAnswers = db.roundState.fakeAnswers || {};
    db.roundState.clues = db.roundState.clues || {};
    db.roundState.accusations = db.roundState.accusations || {};
    if (db.roundState.phase === undefined || db.roundState.phase === null) db.roundState.phase = 'idle';
  }
  return db;
}

function playerIds() { return Object.keys(DB.players); }
function playerName(id) { return (DB.players[id] || {}).name || '?'; }

// ============================================================
// Commit helpers
// ============================================================

// Plain write. Only ever used for state a single device owns and
// nobody else writes concurrently (e.g. the host advancing phase after
// confirming every submission is already in).
async function commit() {
  if (!roomRef) { render(); return; } // local test mode
  await set(roomRef, DB);
}

// Transactional write. Used for anything players write to
// concurrently (submitting an answer, casting a vote, joining the
// lobby) so two simultaneous writes can't clobber each other.
async function transactionalCommit(mutateFn) {
  if (!roomRef) { mutateFn(DB); render(); return; } // local test mode
  await runTransaction(roomRef, (current) => {
    const draft = normaliseDB(current);
    mutateFn(draft);
    return draft;
  });
}

// ============================================================
// Dedup-by-content helpers
// ============================================================

// Picks a random item from `pool` whose `id` hasn't been used yet for
// this round type this session. Falls back to resetting the used-list
// for that round type if the pool is exhausted, so a long session
// never runs dry. Dedup is entirely by stored id string, never by
// object identity, so it survives round trips through Firebase/JSON.
function pickUnused(pool, roundType, usedIds) {
  const used = usedIds[roundType] || [];
  let candidates = pool.filter(p => !used.includes(p.id));
  if (candidates.length === 0) {
    usedIds[roundType] = [];
    candidates = pool;
  }
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  usedIds[roundType] = [...(usedIds[roundType] || []), pick.id];
  return pick;
}

// ============================================================
// Content bank access
// ============================================================

let CONTENT = null;
function loadContent() {
  const el = document.getElementById('content-data');
  CONTENT = JSON.parse(el.textContent);
}

function sayAnythingPool() {
  const tiers = DB.meta.adultMode ? ['standard', '18plus'] : ['standard'];
  return tiers.flatMap(t => CONTENT.sayAnything[t]);
}

function triviaCategoryNames() {
  const names = Object.keys(CONTENT.triviaBluff).filter(c => c !== 'Adult Trivia');
  return DB.meta.adultMode ? [...names, 'Adult Trivia'] : names;
}

function imposterPool() {
  return CONTENT.imposter; // celebrities always standard-tier content, no 18+ layer
}

// ============================================================
// Lobby / session (shared with other batches, reproduced minimally
// here so this file is standalone-testable)
// ============================================================

async function joinAsNewPlayer(name) {
  const id = 'p_' + Math.random().toString(36).slice(2, 10);
  await transactionalCommit((db) => {
    db.players[id] = { id, name, joinedAt: Date.now() };
    db.session.scores[id] = db.session.scores[id] || 0;
  });
  LOCAL_UID = LOCAL_UID || id;
  return id;
}

function addScore(db, playerId, delta) {
  db.session.scores[playerId] = (db.session.scores[playerId] || 0) + delta;
}

// ============================================================
// Round dispatch
// ============================================================

function startRound(type) {
  DB.meta.status = 'in_round';
  DB.session.currentRound = type;
  if (type === 'sayAnything') startSayAnything();
  else if (type === 'triviaBluff') startTriviaBluff();
  else if (type === 'imposter') startImposter();
}

function endRoundInstance() {
  // Called by each round's own logic once its instance count is spent.
  DB.meta.status = 'round_summary';
  commit();
}

// ============================================================
// SayAnything
// 3 instances per session. Everyone (including any named subject in a
// personalised prompt) writes their own answer to the same prompt.
// Anonymous reveal, everyone votes for funniest (not their own),
// +1 point per vote received.
// ============================================================

const SAYANYTHING_INSTANCES = 3;

function startSayAnything() {
  DB.roundState = {
    kind: 'sayAnything',
    instanceIndex: 0,
    totalInstances: SAYANYTHING_INSTANCES,
    phase: 'idle'
  };
  sayAnythingStartInstance();
}

function sayAnythingStartInstance() {
  const rs = DB.roundState;
  const prompt = pickUnused(sayAnythingPool(), 'sayAnything', DB.session.usedPromptIds);
  const ids = playerIds();

  let player1 = null, player2 = null;
  if (prompt.type === 'single') {
    player1 = ids[Math.floor(Math.random() * ids.length)];
  } else if (prompt.type === 'double') {
    const shuffled = [...ids].sort(() => Math.random() - 0.5);
    player1 = shuffled[0];
    player2 = shuffled[1];
  }

  rs.prompt = prompt;
  rs.player1 = player1;
  rs.player2 = player2;
  rs.answers = {};   // playerId -> text
  rs.votes = {};      // voterId -> answerOwnerId
  rs.phase = 'writing';
}

function sayAnythingPromptText() {
  const rs = DB.roundState;
  let text = rs.prompt.text;
  if (rs.player1) text = text.replace('{Player1}', playerName(rs.player1)).replace('{Player}', playerName(rs.player1));
  if (rs.player2) text = text.replace('{Player2}', playerName(rs.player2));
  return text;
}

async function sayAnythingSubmitAnswer(playerId, text) {
  const rs = DB.roundState;
  if (!rs || rs.kind !== 'sayAnything' || rs.phase !== 'writing') return; // phase guard
  if (!text || !text.trim()) return;
  await transactionalCommit((db) => {
    const r = db.roundState;
    if (!r || r.kind !== 'sayAnything' || r.phase !== 'writing') return; // re-check inside txn
    r.answers[playerId] = text.trim();
    if (Object.keys(r.answers).length >= playerIds().length) {
      r.phase = 'voting';
    }
  });
}

async function sayAnythingSubmitVote(voterId, answerOwnerId) {
  const rs = DB.roundState;
  if (!rs || rs.kind !== 'sayAnything' || rs.phase !== 'voting') return;
  if (voterId === answerOwnerId) return; // can't vote for own answer
  await transactionalCommit((db) => {
    const r = db.roundState;
    if (!r || r.kind !== 'sayAnything' || r.phase !== 'voting') return;
    r.votes[voterId] = answerOwnerId;
    const eligibleVoters = playerIds().filter(id => id !== null);
    if (Object.keys(r.votes).length >= eligibleVoters.length) {
      r.phase = 'reveal';
      sayAnythingScoreInstance();
    }
  });
}

function sayAnythingScoreInstance() {
  const db = DB;
  const rs = db.roundState;
  const tally = {};
  Object.values(rs.votes).forEach(ownerId => { tally[ownerId] = (tally[ownerId] || 0) + 1; });
  Object.entries(tally).forEach(([ownerId, count]) => addScore(db, ownerId, count));
  rs.voteTally = tally;
}

function sayAnythingNext() {
  const rs = DB.roundState;
  if (rs.phase !== 'reveal') return; // phase guard
  rs.instanceIndex += 1;
  if (rs.instanceIndex >= rs.totalInstances) {
    endRoundInstance();
  } else {
    sayAnythingStartInstance();
    commit();
  }
}

// ============================================================
// Trivia Bluff
// 5 instances per session. Each instance: one player (rotated) picks
// from 4 random category options, a real question is pulled from that
// category, everyone (including the picker) writes a fake answer, the
// real answer is shuffled in anonymously, everyone votes on which is
// real. +1 per correct guess, +2 to a fake-answer writer per person
// their fake fools. Adult Trivia is just a 15th category offered like
// any other when the 18+ toggle is on, no forced minimum per session.
// ============================================================

const TRIVIABLUFF_INSTANCES = 5;
const TRIVIABLUFF_CATEGORY_OPTIONS = 4;

function startTriviaBluff() {
  DB.roundState = {
    kind: 'triviaBluff',
    instanceIndex: 0,
    totalInstances: TRIVIABLUFF_INSTANCES,
    pickerOrder: [...playerIds()].sort(() => Math.random() - 0.5),
    phase: 'idle'
  };
  triviaBluffStartInstance();
}

function triviaBluffStartInstance() {
  const rs = DB.roundState;
  const picker = rs.pickerOrder[rs.instanceIndex % rs.pickerOrder.length];
  const allCats = triviaCategoryNames();
  const options = [...allCats].sort(() => Math.random() - 0.5).slice(0, Math.min(TRIVIABLUFF_CATEGORY_OPTIONS, allCats.length));

  rs.picker = picker;
  rs.categoryOptions = options;
  rs.chosenCategory = null;
  rs.question = null;
  rs.fakeAnswers = {};   // playerId -> text (includes the picker)
  rs.votes = {};          // voterId -> "real" | playerId (whose fake they picked)
  rs.phase = 'choosing_category';
}

async function triviaBluffChooseCategory(playerId, category) {
  const rs = DB.roundState;
  if (!rs || rs.kind !== 'triviaBluff' || rs.phase !== 'choosing_category') return;
  if (playerId !== rs.picker) return;
  if (!rs.categoryOptions.includes(category)) return;
  await transactionalCommit((db) => {
    const r = db.roundState;
    if (!r || r.phase !== 'choosing_category') return;
    r.chosenCategory = category;
    r.question = pickUnused(CONTENT.triviaBluff[category], 'triviaBluff', db.session.usedPromptIds);
    r.phase = 'writing';
  });
}

async function triviaBluffSubmitFake(playerId, text) {
  const rs = DB.roundState;
  if (!rs || rs.kind !== 'triviaBluff' || rs.phase !== 'writing') return;
  if (!text || !text.trim()) return;
  // Reject a fake that's just the real answer restated (case-insensitive)
  if (text.trim().toLowerCase() === rs.question.a.trim().toLowerCase()) return;
  await transactionalCommit((db) => {
    const r = db.roundState;
    if (!r || r.phase !== 'writing') return;
    r.fakeAnswers[playerId] = text.trim();
    if (Object.keys(r.fakeAnswers).length >= playerIds().length) {
      r.phase = 'voting';
      r.shuffledOptions = buildTriviaOptions(r);
    }
  });
}

// Builds the anonymous, shuffled option list once, so it doesn't
// reshuffle under players mid-vote. "real" is a literal marker, not a
// player id, so it can't collide with one.
function buildTriviaOptions(rs) {
  const opts = Object.entries(rs.fakeAnswers).map(([pid, text]) => ({ ownerId: pid, text }));
  opts.push({ ownerId: 'real', text: rs.question.a });
  return opts.sort(() => Math.random() - 0.5);
}

async function triviaBluffSubmitVote(voterId, ownerId) {
  const rs = DB.roundState;
  if (!rs || rs.kind !== 'triviaBluff' || rs.phase !== 'voting') return;
  if (ownerId === voterId) return; // can't vote your own fake
  await transactionalCommit((db) => {
    const r = db.roundState;
    if (!r || r.phase !== 'voting') return;
    r.votes[voterId] = ownerId;
    if (Object.keys(r.votes).length >= playerIds().length) {
      r.phase = 'reveal';
      triviaBluffScoreInstance();
    }
  });
}

function triviaBluffScoreInstance() {
  const db = DB;
  const rs = db.roundState;
  Object.entries(rs.votes).forEach(([voterId, ownerId]) => {
    if (ownerId === 'real') addScore(db, voterId, 1); // correct guess
    else addScore(db, ownerId, 2); // fake writer fooled someone
  });
}

function triviaBluffNext() {
  const rs = DB.roundState;
  if (rs.phase !== 'reveal') return; // phase guard
  rs.instanceIndex += 1;
  if (rs.instanceIndex >= rs.totalInstances) {
    endRoundInstance();
  } else {
    triviaBluffStartInstance();
    commit();
  }
}

// ============================================================
// Imposter
// 2 instances per session, 4-12 players (same range as the lobby, no
// tighter constraint). Engine picks celebrity/historical-figure vs a
// real lobby player randomly each instance. One player is the
// imposter and sees only a vague category hint; everyone else sees
// the real subject. Two rounds of one-word clues, then everyone votes
// (no self-votes). Confirmed scoring:
//   - correct accuser (voted for the real imposter):        +1
//   - wrong accuser (voted for an innocent player):          -1
//   - the imposter, per player who correctly accused them:   -1 each
//   - the imposter, per player who did NOT accuse them:      +1 each
//   - a wrongly-accused innocent, per player who accused them: -2 each
//   - no separate bonus for the imposter naming the real subject.
// This formula handles ties on its own (each suspect's points scale
// with however many votes they personally received), so there's no
// separate tie-breaking branch needed.
// ============================================================

const IMPOSTER_INSTANCES = 2;
const IMPOSTER_CLUE_ROUNDS = 2;

function startImposter() {
  DB.roundState = {
    kind: 'imposter',
    instanceIndex: 0,
    totalInstances: IMPOSTER_INSTANCES,
    phase: 'idle'
  };
  imposterStartInstance();
}

function imposterStartInstance() {
  const rs = DB.roundState;
  const ids = playerIds();
  const imposterId = ids[Math.floor(Math.random() * ids.length)];
  const subjectMode = Math.random() < 0.5 ? 'celebrity' : 'player';

  let subjectName, categoryHint, subjectContentId = null;
  if (subjectMode === 'celebrity' || ids.length < 2) {
    const celeb = pickUnused(imposterPool(), 'imposter', DB.session.usedPromptIds);
    subjectName = celeb.name;
    categoryHint = celeb.category;
    subjectContentId = celeb.id;
  } else {
    const candidates = ids.filter(id => id !== imposterId);
    const subjectId = candidates[Math.floor(Math.random() * candidates.length)];
    subjectName = playerName(subjectId);
    categoryHint = 'Someone in this group';
  }

  rs.imposterId = imposterId;
  rs.subjectMode = subjectMode;
  rs.subjectName = subjectName;
  rs.subjectContentId = subjectContentId;
  rs.categoryHint = categoryHint;
  rs.clueRound = 1;
  rs.totalClueRounds = IMPOSTER_CLUE_ROUNDS;
  rs.clues = { 1: {}, 2: {} };
  rs.votes = {};
  rs.phase = 'clues';
}

// What a given player should see for the subject: the real name for
// everyone except the imposter, who only sees the vague hint.
function imposterViewFor(playerId) {
  const rs = DB.roundState;
  if (playerId === rs.imposterId) return { hint: rs.categoryHint };
  return { name: rs.subjectName };
}

async function imposterSubmitClue(playerId, word) {
  const rs = DB.roundState;
  if (!rs || rs.kind !== 'imposter' || rs.phase !== 'clues') return;
  if (!word || !word.trim()) return;
  await transactionalCommit((db) => {
    const r = db.roundState;
    if (!r || r.phase !== 'clues') return;
    r.clues[r.clueRound][playerId] = word.trim().split(/\s+/)[0]; // enforce one word
    if (Object.keys(r.clues[r.clueRound]).length >= playerIds().length) {
      if (r.clueRound < r.totalClueRounds) {
        r.clueRound += 1;
      } else {
        r.phase = 'voting';
      }
    }
  });
}

async function imposterSubmitVote(voterId, suspectId) {
  const rs = DB.roundState;
  if (!rs || rs.kind !== 'imposter' || rs.phase !== 'voting') return;
  if (voterId === suspectId) return; // no self-votes
  await transactionalCommit((db) => {
    const r = db.roundState;
    if (!r || r.phase !== 'voting') return;
    r.votes[voterId] = suspectId;
    if (Object.keys(r.votes).length >= playerIds().length) {
      r.phase = 'reveal';
      imposterScoreInstance();
    }
  });
}

function imposterScoreInstance() {
  const db = DB;
  const rs = db.roundState;
  const imposterId = rs.imposterId;
  const others = playerIds().filter(id => id !== imposterId);
  let accusersOfImposter = 0;

  Object.entries(rs.votes).forEach(([voterId, suspectId]) => {
    if (suspectId === imposterId) {
      addScore(db, voterId, 1);      // correct accuser
      addScore(db, imposterId, -1);  // imposter penalised per correct accuser
      accusersOfImposter += 1;
    } else {
      addScore(db, suspectId, -2);   // wrongly-accused innocent
      addScore(db, voterId, -1);     // wrong accuser
    }
  });

  const fooledCount = others.length - accusersOfImposter;
  addScore(db, imposterId, fooledCount); // +1 per player who didn't suspect the imposter
}

function imposterNext() {
  const rs = DB.roundState;
  if (rs.phase !== 'reveal') return; // phase guard
  rs.instanceIndex += 1;
  if (rs.instanceIndex >= rs.totalInstances) {
    endRoundInstance();
  } else {
    imposterStartInstance();
    commit();
  }
}

// ============================================================
// Minimal render layer for standalone browser testing.
// This is intentionally simple: on merge into the main build, these
// three rounds plug into the existing render/router the same way
// Ranking Wars, Secret Opinions and Crystal Ball did for batch 2.
// LOCAL_UID picks which player's perspective this browser tab shows,
// via a dropdown, so one machine can playtest multiple "phones" across
// tabs/profiles same as before.
// ============================================================

const RENDER_ERRORS = [];

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'onclick') e.addEventListener('click', v);
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach(c => {
    if (c === null || c === undefined) return;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return e;
}

function render() {
  try { doRender(); }
  catch (e) { RENDER_ERRORS.push({ message: e.message, stack: e.stack }); console.error('render error', e); }
}

function doRender() {
  const root = document.getElementById('app');
  if (!root) return;
  root.innerHTML = '';
  if (!DB) { root.appendChild(el('p', {}, 'Loading...')); return; }

  root.appendChild(renderPlayerSwitcher());

  if (DB.meta.status === 'lobby') { root.appendChild(renderLobby()); return; }
  if (DB.meta.status === 'round_summary') { root.appendChild(renderSummary()); return; }
  if (DB.meta.status === 'in_round') {
    const rs = DB.roundState;
    if (!rs) { root.appendChild(el('p', {}, 'No active round.')); return; }
    if (rs.kind === 'sayAnything') root.appendChild(renderSayAnything());
    else if (rs.kind === 'triviaBluff') root.appendChild(renderTriviaBluff());
    else if (rs.kind === 'imposter') root.appendChild(renderImposter());
  }
}

function renderPlayerSwitcher() {
  const wrap = el('div', { class: 'switcher' });
  const select = el('select', { onclick: (e) => e.stopPropagation() });
  select.addEventListener('change', (e) => { LOCAL_UID = e.target.value; render(); });
  playerIds().forEach(id => {
    const opt = el('option', { value: id }, playerName(id) + (id === LOCAL_UID ? ' (you)' : ''));
    if (id === LOCAL_UID) opt.selected = true;
    select.appendChild(opt);
  });
  wrap.appendChild(el('span', {}, 'Viewing as: '));
  wrap.appendChild(select);
  return wrap;
}

function renderLobby() {
  const wrap = el('div');
  wrap.appendChild(el('h2', {}, 'Lobby'));
  wrap.appendChild(el('ul', {}, playerIds().map(id => el('li', {}, playerName(id)))));
  const nameInput = el('input', { placeholder: 'Your name' });
  wrap.appendChild(nameInput);
  wrap.appendChild(el('button', { onclick: () => { if (nameInput.value.trim()) joinAsNewPlayer(nameInput.value.trim()); } }, 'Join'));
  wrap.appendChild(el('div', {}, [
    el('button', { onclick: () => { startRound('sayAnything'); commit(); } }, 'Start SayAnything'),
    el('button', { onclick: () => { startRound('triviaBluff'); commit(); } }, 'Start Trivia Bluff'),
    el('button', { onclick: () => { startRound('imposter'); commit(); } }, 'Start Imposter')
  ]));
  return wrap;
}

function renderScores() {
  return el('ul', { class: 'scores' }, playerIds().map(id =>
    el('li', {}, `${playerName(id)}: ${DB.session.scores[id] || 0}`)
  ));
}

function renderSummary() {
  const wrap = el('div');
  wrap.appendChild(el('h2', {}, 'Round summary'));
  wrap.appendChild(renderScores());
  wrap.appendChild(el('button', { onclick: () => { DB.meta.status = 'lobby'; DB.session.currentRound = null; commit(); } }, 'Back to lobby'));
  return wrap;
}

function renderSayAnything() {
  const rs = DB.roundState;
  const wrap = el('div');
  wrap.appendChild(el('h2', {}, `SayAnything (${rs.instanceIndex + 1}/${rs.totalInstances})`));
  wrap.appendChild(el('p', {}, sayAnythingPromptText()));

  if (rs.phase === 'writing') {
    if (rs.answers[LOCAL_UID] !== undefined) {
      wrap.appendChild(el('p', {}, 'Answer submitted. Waiting for others...'));
    } else {
      const input = el('input', { placeholder: 'Your answer' });
      wrap.appendChild(input);
      wrap.appendChild(el('button', { onclick: () => sayAnythingSubmitAnswer(LOCAL_UID, input.value) }, 'Submit'));
    }
  } else if (rs.phase === 'voting') {
    if (rs.votes[LOCAL_UID] !== undefined) {
      wrap.appendChild(el('p', {}, 'Vote submitted. Waiting for others...'));
    } else {
      Object.entries(rs.answers).forEach(([ownerId, text]) => {
        if (ownerId === LOCAL_UID) return;
        wrap.appendChild(el('button', { onclick: () => sayAnythingSubmitVote(LOCAL_UID, ownerId) }, text));
      });
    }
  } else if (rs.phase === 'reveal') {
    Object.entries(rs.answers).forEach(([ownerId, text]) => {
      wrap.appendChild(el('p', {}, `${playerName(ownerId)}: "${text}" — ${rs.voteTally[ownerId] || 0} vote(s)`));
    });
    wrap.appendChild(renderScores());
    wrap.appendChild(el('button', { onclick: sayAnythingNext }, 'Next'));
  }
  return wrap;
}

function renderTriviaBluff() {
  const rs = DB.roundState;
  const wrap = el('div');
  wrap.appendChild(el('h2', {}, `Trivia Bluff (${rs.instanceIndex + 1}/${rs.totalInstances})`));

  if (rs.phase === 'choosing_category') {
    wrap.appendChild(el('p', {}, `${playerName(rs.picker)} is choosing a category...`));
    if (LOCAL_UID === rs.picker) {
      rs.categoryOptions.forEach(cat => {
        wrap.appendChild(el('button', { onclick: () => triviaBluffChooseCategory(LOCAL_UID, cat) }, cat));
      });
    }
  } else if (rs.phase === 'writing') {
    wrap.appendChild(el('p', {}, rs.question.q));
    if (rs.fakeAnswers[LOCAL_UID] !== undefined) {
      wrap.appendChild(el('p', {}, 'Fake answer submitted. Waiting for others...'));
    } else {
      const input = el('input', { placeholder: 'Your fake answer' });
      wrap.appendChild(input);
      wrap.appendChild(el('button', { onclick: () => triviaBluffSubmitFake(LOCAL_UID, input.value) }, 'Submit'));
    }
  } else if (rs.phase === 'voting') {
    wrap.appendChild(el('p', {}, rs.question.q));
    if (rs.votes[LOCAL_UID] !== undefined) {
      wrap.appendChild(el('p', {}, 'Vote submitted. Waiting for others...'));
    } else {
      rs.shuffledOptions.forEach(opt => {
        if (opt.ownerId === LOCAL_UID) return;
        wrap.appendChild(el('button', { onclick: () => triviaBluffSubmitVote(LOCAL_UID, opt.ownerId) }, opt.text));
      });
    }
  } else if (rs.phase === 'reveal') {
    wrap.appendChild(el('p', {}, `${rs.question.q} — Real answer: ${rs.question.a}`));
    wrap.appendChild(renderScores());
    wrap.appendChild(el('button', { onclick: triviaBluffNext }, 'Next'));
  }
  return wrap;
}

function renderImposter() {
  const rs = DB.roundState;
  const wrap = el('div');
  wrap.appendChild(el('h2', {}, `Imposter (${rs.instanceIndex + 1}/${rs.totalInstances})`));

  const view = imposterViewFor(LOCAL_UID);
  wrap.appendChild(el('p', {}, view.name ? `Subject: ${view.name}` : `You are the imposter. Category hint: ${view.hint}`));

  if (rs.phase === 'clues') {
    wrap.appendChild(el('p', {}, `Clue round ${rs.clueRound}/${rs.totalClueRounds}`));
    if (rs.clues[rs.clueRound][LOCAL_UID] !== undefined) {
      wrap.appendChild(el('p', {}, 'Clue submitted. Waiting for others...'));
    } else {
      const input = el('input', { placeholder: 'One word' });
      wrap.appendChild(input);
      wrap.appendChild(el('button', { onclick: () => imposterSubmitClue(LOCAL_UID, input.value) }, 'Submit'));
    }
  } else if (rs.phase === 'voting') {
    if (rs.votes[LOCAL_UID] !== undefined) {
      wrap.appendChild(el('p', {}, 'Vote submitted. Waiting for others...'));
    } else {
      playerIds().filter(id => id !== LOCAL_UID).forEach(id => {
        wrap.appendChild(el('button', { onclick: () => imposterSubmitVote(LOCAL_UID, id) }, playerName(id)));
      });
    }
  } else if (rs.phase === 'reveal') {
    wrap.appendChild(el('p', {}, `The imposter was ${playerName(rs.imposterId)}. Real subject: ${rs.subjectName}`));
    wrap.appendChild(renderScores());
    wrap.appendChild(el('button', { onclick: imposterNext }, 'Next'));
  }
  return wrap;
}

// ============================================================
// Boot
// ============================================================

window.addEventListener('DOMContentLoaded', () => {
  loadContent();
  DB = freshDB();
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  if (room) initFirebase(room);
  else render(); // local test mode, no Firebase, in-memory DB only
});
