// Clash — real-time 1v1 quickfire debate server.
// The server owns the clock and the match state; browsers only send actions.
import express from "express";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { MOTIONS } from "./motions.js";
import { ai, AI } from "./ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const TIME_SCALE = Number(process.env.TIME_SCALE) || 1; // tests use e.g. 0.05
const FORFEIT_SECONDS = 30;

// Oyaple-style timings (seconds)
const DUR = { motion: 15, motionReveal: 4, side: 10, sideReveal: 3, prep: 20, speech: 30, open: 45 };
const ORDER = [
  { side: "FOR", round: 1 }, { side: "AGAINST", round: 1 },
  { side: "FOR", round: 2 }, { side: "AGAINST", round: 2 },
];
const CRITERIA = ["logical", "evidence", "rebuttal", "delivery", "persuasion"];
const LEVELS = {
  novice: "a nervous first-year debater: plain arguments, some gaps in logic, light on evidence, simple rebuttals",
  varsity: "a solid competitive high-school debater: clear claims with reasons, a concrete example or statistic, direct rebuttal",
  champion: "a national-champion debater: tight logic, sharp concrete evidence, surgical rebuttal of the opponent's weakest link, memorable framing",
};

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (_req, res) => res.json({ ok: true, ai: AI.on, provider: AI.provider }));
// Voice relay servers. Optional ICE_SERVERS env var: a JSON array, e.g. from a TURN provider.
let ICE_SERVERS = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
try { if (process.env.ICE_SERVERS) ICE_SERVERS = JSON.parse(process.env.ICE_SERVERS); } catch { console.error("ICE_SERVERS is not valid JSON; using STUN only"); }
app.get("/config", (_req, res) => res.json({ iceServers: ICE_SERVERS }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

/* ------------------------------------------------------------------ */
const rooms = new Map();    // code -> room
const people = new Map();   // pid -> { pid, name, socketId, room }
let queue = [];             // pids waiting for quick match

const rnd = (a) => a[Math.floor(Math.random() * a.length)];
const other = (s) => (s === "FOR" ? "AGAINST" : "FOR");
const now = () => Date.now();
const clean = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
function shuffle(a) { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function code() { let c; do { c = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random() * 24)]).join(""); } while (rooms.has(c)); return c; }

function makeRoom({ bot = null, isPrivate = false } = {}) {
  const room = { code: code(), players: [], phase: "waiting", endsAt: null, seq: 0, timer: null, bot, isPrivate, matchNo: 0 };
  rooms.set(room.code, room);
  return room;
}
function addPlayer(room, pid) {
  const p = people.get(pid);
  if (p.room && p.room !== room.code) leaveRoom(pid, true);
  room.players.push({ pid, name: p.name, bot: false, connected: true });
  p.room = room.code;
  const s = io.sockets.sockets.get(p.socketId);
  s?.join(room.code);
}
function addBot(room, level) {
  room.players.push({ pid: "bot", name: `AI · ${level[0].toUpperCase()}${level.slice(1)}`, bot: true, connected: true });
}
function humans(room) { return room.players.filter((p) => !p.bot); }
function idxOf(room, pid) { return room.players.findIndex((p) => p.pid === pid); }
function speakerIdx(room, i) { return room.players.findIndex((p) => p.side === ORDER[i].side); }

/* ---------- broadcasting ---------- */
function view(room, me) {
  const ph = room.phase;
  const reveal = ph === "motionReveal" || ph === "sideReveal" || ph === "prep" || ph.startsWith("speech") || ph === "open" || ph === "judging" || ph === "result";
  return {
    code: room.code, phase: ph, endsAt: room.endsAt, serverNow: now(), you: me, isPrivate: room.isPrivate, matchNo: room.matchNo,
    vsBot: Boolean(room.bot), ai: AI.on,
    players: room.players.map((p, i) => ({
      name: p.name, bot: p.bot, connected: p.connected, side: p.side ?? null,
      voted: p.vote != null, picked: p.sidePick != null, ready: !!p.ready, rematch: !!p.rematch,
      vote: i === me || ph !== "motion" ? p.vote ?? null : null,
      sidePick: i === me || ph !== "side" ? p.sidePick ?? null : null,
    })),
    motions: room.motions ?? null,
    motion: reveal ? room.motion ?? null : null,
    motionNote: room.motionNote ?? null,
    sideNote: room.sideNote ?? null,
    speechIndex: room.speechIndex ?? null,
    speeches: room.speeches ?? [],
    open: room.open ?? [],
    result: ph === "result" ? room.result : null,
  };
}
function broadcast(room) {
  room.players.forEach((p, i) => {
    if (p.bot) return;
    const sid = people.get(p.pid)?.socketId;
    if (sid) io.to(sid).emit("state", view(room, i));
  });
}
function setPhase(room, phase, seconds, onEnd) {
  clearTimeout(room.timer);
  room.phase = phase;
  room.seq++;
  const seq = room.seq;
  room.endsAt = seconds ? now() + seconds * 1000 * TIME_SCALE : null;
  if (seconds) room.timer = setTimeout(() => { if (room.seq === seq) onEnd(); }, seconds * 1000 * TIME_SCALE);
  broadcast(room);
  return seq;
}
const later = (room, seq, ms, fn) => setTimeout(() => { if (room.seq === seq && rooms.has(room.code)) fn(); }, ms * TIME_SCALE);

/* ---------- match flow ---------- */
function startMatch(room) {
  room.matchNo++;
  Object.assign(room, { motions: shuffle(MOTIONS).slice(0, 5), motion: null, motionNote: null, sideNote: null,
    speeches: [], drafts: [], open: [], result: null, speechIndex: null, botCache: {} });
  room.players.forEach((p) => Object.assign(p, { vote: null, sidePick: null, side: null, ready: false, rematch: false }));
  const seq = setPhase(room, "motion", DUR.motion, () => resolveMotion(room));
  const b = room.players.find((p) => p.bot);
  if (b) later(room, seq, 2000 + Math.random() * 5000, () => { b.vote = Math.floor(Math.random() * 5); checkAll(room); });
}
function checkAll(room) {
  const ps = room.players;
  if (room.phase === "motion" && ps.every((p) => p.vote != null)) return resolveMotion(room);
  if (room.phase === "side" && ps.every((p) => p.sidePick != null)) return resolveSide(room);
  if (room.phase === "prep" && ps.every((p) => p.ready)) return speech(room, 0);
  if (room.phase === "result" && ps.every((p) => p.rematch)) return startMatch(room);
  broadcast(room);
}
function resolveMotion(room) {
  const [a, b] = room.players;
  for (const p of room.players) if (p.vote == null) p.vote = Math.floor(Math.random() * 5);
  const chosen = a.vote === b.vote ? a.vote : rnd([a.vote, b.vote]);
  room.motion = room.motions[chosen];
  room.motionNote = a.vote === b.vote ? "Same pick. That's the motion." : "Different picks. Coin flip between the two.";
  setPhase(room, "motionReveal", DUR.motionReveal, () => sidePhase(room));
}
function sidePhase(room) {
  const seq = setPhase(room, "side", DUR.side, () => resolveSide(room));
  const b = room.players.find((p) => p.bot);
  if (b) later(room, seq, 1500 + Math.random() * 3000, () => { b.sidePick = rnd(["FOR", "AGAINST"]); checkAll(room); });
}
function resolveSide(room) {
  const [a, b] = room.players;
  let note;
  if (a.sidePick && b.sidePick && a.sidePick !== b.sidePick) { a.side = a.sidePick; b.side = b.sidePick; note = "Different picks. Everyone gets their choice."; }
  else if (a.sidePick && !b.sidePick) { a.side = a.sidePick; b.side = other(a.side); note = `${b.name} didn't pick in time.`; }
  else if (!a.sidePick && b.sidePick) { b.side = b.sidePick; a.side = other(b.side); note = `${a.name} didn't pick in time.`; }
  else { a.side = rnd(["FOR", "AGAINST"]); b.side = other(a.side); note = a.sidePick ? `You both wanted ${a.sidePick}. Randomized.` : "Nobody picked. Randomized."; }
  room.sideNote = note;
  setPhase(room, "sideReveal", DUR.sideReveal, () => prep(room));
}
function prep(room) {
  const b = room.players.find((p) => p.bot);
  if (b) { b.ready = true; if (b.side === "FOR") botSpeechText(room, 1); }
  setPhase(room, "prep", DUR.prep, () => speech(room, 0));
}
function speech(room, i) {
  if (i >= ORDER.length) return openFloor(room);
  room.speechIndex = i;
  room.drafts[i] = "";
  const seq = setPhase(room, "speech" + i, DUR.speech, () => endSpeech(room, i));
  const sp = room.players[speakerIdx(room, i)];
  if (sp?.bot) botSpeak(room, i, seq);
  else if (sp && !sp.connected) later(room, seq, 3000, () => endSpeech(room, i)); // skip absent speaker quickly
}
function endSpeech(room, i) {
  if (room.phase !== "speech" + i) return;
  room.speeches[i] = { side: ORDER[i].side, round: ORDER[i].round, text: clean(room.drafts[i], 4000) };
  io.to(room.code).emit("speechSync", { i, text: room.speeches[i].text });
  speech(room, i + 1);
}
function openFloor(room) {
  room.speechIndex = null;
  const seq = setPhase(room, "open", DUR.open, () => judge(room));
  if (room.bot) {
    room.botOpen = { busy: false, owed: false, count: 0, lastHuman: now() };
    later(room, seq, 2500, () => { if (!room.open.length) botReply(room, seq); });
    const iv = setInterval(() => {
      if (room.seq !== seq) return clearInterval(iv);
      if (!room.botOpen.busy && room.open.length && now() - room.botOpen.lastHuman > 13000 * TIME_SCALE) { room.botOpen.lastHuman = now(); botReply(room, seq); }
    }, 1000 * TIME_SCALE);
  }
}
function addOpenLine(room, idx, text) {
  const p = room.players[idx];
  const line = { side: p.side, who: idx, text: clean(text, 400), t: now() };
  if (!line.text) return;
  room.open.push(line);
  if (room.open.length > 120) room.open.shift();
  io.to(room.code).emit("openLine", line);
}

/* ---------- transcript & judging ---------- */
function transcript(room, upto = 4, withOpen = false) {
  const out = [];
  for (let i = 0; i < upto; i++) {
    const s = room.speeches[i]; if (!s) continue;
    out.push(`[${s.side} — Round ${s.round} speech]\n${s.text || "(no speech delivered)"}`);
  }
  if (withOpen) out.push("[Open discussion]\n" + (room.open.length ? room.open.map((m) => `${m.side}: ${m.text}`).join("\n") : "(nothing said)"));
  return out.join("\n\n");
}
function offlineScore(room, side) {
  const own = room.speeches.filter((s) => s?.side === side).map((s) => s.text).join(" ") + " " + room.open.filter((m) => m.side === side).map((m) => m.text).join(" ");
  const lw = own.toLowerCase(); const w = (own.match(/\S+/g) || []).length;
  const has = (re) => (lw.match(re) || []).length; const base = Math.min(1, w / 140);
  const ev = has(/\d|percent|study|studies|research|data|for example|for instance|according/g);
  const rb = has(/opponent|they said|they claim|they argue|but |however|even if|doesn't|didn't|ignore/g);
  const st = has(/first|second|third|finally|because|therefore|which means/g);
  const f = (x) => Math.max(2, Math.min(18, Math.round(x)));
  return { logical: f(4 + base * 8 + st * 0.8), evidence: f(3 + base * 5 + ev * 1.5), rebuttal: f(3 + base * 5 + rb * 1.2), delivery: f(5 + base * 9), persuasion: f(4 + base * 7 + (ev + rb) * 0.5) };
}
function clampScores(o) { const r = {}; for (const k of CRITERIA) { const v = Math.round(Number(o?.[k])); r[k] = Number.isFinite(v) ? Math.max(0, Math.min(20, v)) : 10; } return r; }
function parseJson(text) { const a = text.indexOf("{"), b = text.lastIndexOf("}"); if (a < 0 || b < a) throw new Error("no JSON"); return JSON.parse(text.slice(a, b + 1)); }

async function judge(room) {
  const seq = setPhase(room, "judging", 0);
  let res = null, offline = false;
  if (AI.on) {
    const prompt = `You are an impartial, experienced competitive debate judge. Score a short 1v1 debate.
Format: each debater gave two 30-second spoken speeches (Round 1 opening, Round 2 rebuttal and extension), then a 45-second open discussion with no turn order. Everything below is a speech-to-text transcript, so ignore obvious transcription glitches and missing punctuation; judge Delivery Clarity on how clear, organized and easy to follow the spoken argument is.

Motion: "${room.motion}"

${transcript(room, 4, true)}

Score each debater on five criteria, each an INTEGER from 0 to 20:
- logical: Logical Consistency — claims follow from reasons, no contradictions
- evidence: Use of Evidence — concrete examples, data, real-world support
- rebuttal: Rebuttal Quality — directly engaging and defeating the other side's points
- delivery: Delivery Clarity — clear structure and wording
- persuasion: Persuasiveness — how convincing overall
Judge only what was said, never which side you personally agree with. Use the full range: a missing or empty speech earns very low marks, an average novice effort is about 9–12 per criterion, excellent work is 17+. Avoid identical totals unless the debaters were truly equal.

Reply with only JSON in exactly this shape:
{"FOR":{"logical":0,"evidence":0,"rebuttal":0,"delivery":0,"persuasion":0},
 "AGAINST":{"logical":0,"evidence":0,"rebuttal":0,"delivery":0,"persuasion":0},
 "notes":{"FOR":{"logical":"one short sentence","evidence":"...","rebuttal":"...","delivery":"...","persuasion":"..."},"AGAINST":{"logical":"...","evidence":"...","rebuttal":"...","delivery":"...","persuasion":"..."}},
 "summary":"2-3 sentences explaining the decision",
 "tips":{"FOR":["tip","tip","tip"],"AGAINST":["tip","tip","tip"]}}`;
    try { res = parseJson(await ai(prompt, { role: "judge", maxTokens: 2000 })); }
    catch (e) { console.error("judge failed:", e.message); res = null; }
  }
  if (!res || !res.FOR || !res.AGAINST) {
    offline = true;
    res = { FOR: offlineScore(room, "FOR"), AGAINST: offlineScore(room, "AGAINST"), notes: {},
      summary: AI.on ? "The free AI judge was busy or didn't answer, so this is the offline estimate based on length, structure, evidence and direct responses."
        : "AI judging is turned off on this server, so this is the offline estimate based on length, structure, evidence and direct responses.", tips: {} };
  }
  if (room.seq !== seq || !rooms.has(room.code)) return;
  const scores = { FOR: clampScores(res.FOR), AGAINST: clampScores(res.AGAINST) };
  const tot = (s) => CRITERIA.reduce((a, k) => a + s[k], 0);
  const tf = tot(scores.FOR), ta = tot(scores.AGAINST);
  room.result = { scores, totals: { FOR: tf, AGAINST: ta }, winner: tf > ta ? "FOR" : ta > tf ? "AGAINST" : null,
    notes: res.notes || {}, summary: clean(res.summary, 800), tips: res.tips || {}, offline, forfeit: null,
    transcript: { speeches: room.speeches, open: room.open } };
  setPhase(room, "result", 0);
  const b = room.players.find((p) => p.bot); if (b) b.rematch = true;
}
function forfeit(room, loserIdx) {
  const winner = room.players[1 - loserIdx];
  room.result = { forfeit: { winner: 1 - loserIdx, name: winner?.name }, scores: null, totals: null, winner: winner?.side ?? null, notes: {}, summary: "", tips: {}, offline: false,
    transcript: { speeches: room.speeches || [], open: room.open || [] } };
  setPhase(room, "result", 0);
}

/* ---------- AI opponent ---------- */
function stockSpeech(side, motion, round) {
  const pro = side === "FOR";
  if (round === 1) return pro
    ? `The motion "${motion}" stands on one idea: when a change makes people better off and the costs are manageable, we should make it. The status quo keeps producing the same problems. My side offers a clear fix with benefits you can see within a year. The burden is on my opponent to show the harms outweigh that.`
    : `We oppose "${motion}". Big changes need strong proof, and the other side offers hope instead of evidence. Their plan lands hardest on the people with the least room to adapt, and there are cheaper, targeted fixes. Until they show the benefit outweighs the cost, vote against.`;
  return pro
    ? "My opponent's case rests on fear of change, but they never showed the harm actually happens. They didn't answer my core point about who benefits. Even if some costs exist, they're smaller and easier to fix than the problems we live with today. Weigh what's certain against what's speculative. Pass the motion."
    : "My opponent keeps describing a best-case world. Real implementation is messy, and they skipped right past cost and unintended consequences. They never explained why a targeted fix wouldn't work just as well. When one side brings certainty about harms and the other brings optimism, side with caution. Oppose.";
}
function botSpeechText(room, round) {
  if (room.botCache[round]) return room.botCache[round];
  const b = room.players.find((p) => p.bot);
  const human = room.players.find((p) => !p.bot);
  const idx = ORDER.findIndex((o) => o.side === b.side && o.round === round);
  const p = (async () => {
    if (!AI.on) return stockSpeech(b.side, room.motion, round);
    const prompt = `You are playing a debater in a fast 1v1 spoken debate game. Stay in character.
Motion: "${room.motion}"
Your side: ${b.side} the motion. Your opponent (${human?.name || "opponent"}) argues ${other(b.side)}.
Your skill: ${LEVELS[room.bot]}.
This is your Round ${round} speech, spoken aloud in 30 seconds, so write 60 to 75 words.
${round === 1 ? "Open your case with your two strongest reasons." + (idx > 0 ? " Briefly answer your opponent's opening too." : "") : "Rebut your opponent's specific points from the transcript, extend your case, and close with one line on why your side wins."}
The transcript is speech-to-text, so ignore glitches. If your opponent's speech is empty or off-topic, point that out.
Write only the words you say: plain text, first person, no title, no stage directions.

Transcript so far:
${transcript(room, idx) || "(you speak first)"}`;
    try { return await ai(prompt, { role: "bot", maxTokens: 300 }); }
    catch (e) { if (!/slot/.test(e.message)) console.error("bot speech failed:", e.message); return stockSpeech(b.side, room.motion, round); }
  })();
  room.botCache[round] = p;
  return p;
}
async function botSpeak(room, i, seq) {
  const text = await botSpeechText(room, ORDER[i].round);
  if (room.seq !== seq) return;
  io.to(room.code).emit("botSay", { i, text });
  const wordsArr = text.match(/\S+\s*/g) || [];
  let n = 0;
  const iv = setInterval(() => {
    if (room.seq !== seq) return clearInterval(iv);
    n = Math.min(wordsArr.length, n + 1);
    room.drafts[i] = wordsArr.slice(0, n).join("");
    io.to(room.code).emit("caption", { i, text: room.drafts[i] });
    if (n >= wordsArr.length) { clearInterval(iv); later(room, seq, 1500, () => endSpeech(room, i)); }
  }, 370 * TIME_SCALE); // ~2.7 words per second, a natural speaking pace
}
async function botReply(room, seq) {
  const st = room.botOpen;
  if (st.busy || st.count >= 7) { st.owed = true; return; }
  st.busy = true;
  const b = room.players.find((p) => p.bot);
  let text = "";
  if (AI.on) {
    const prompt = `You are in the 45-second open discussion of a fast 1v1 spoken debate game. Stay in character.
Motion: "${room.motion}". You argue ${b.side}. Your opponent argues ${other(b.side)}.
Your skill: ${LEVELS[room.bot]}.
Say ONE punchy line of at most 25 words that presses your opponent's weakest point or answers their latest line. Plain text only.

Speeches:
${transcript(room, 4)}

Open discussion so far:
${room.open.map((m) => `${m.side}: ${m.text}`).join("\n") || "(nothing yet; open with a direct challenge)"}`;
    try { text = await ai(prompt, { role: "chat", maxTokens: 120 }); } catch (e) { if (!/slot/.test(e.message)) console.error("bot reply failed:", e.message); }
  }
  if (!text) text = rnd(["You still haven't answered my main point.", "Where's your evidence for that?", "That's a best-case scenario, not a plan.", "Name one real example and I'll concede.", "Costs matter. You keep skipping them."]);
  st.busy = false;
  if (room.seq !== seq) return;
  st.count++;
  const bi = room.players.indexOf(b);
  addOpenLine(room, bi, text);
  io.to(room.code).emit("botSay", { i: "open", text });
  if (st.owed) { st.owed = false; later(room, seq, 600, () => botReply(room, seq)); }
}

/* ---------- leaving / disconnects ---------- */
function activePhase(room) { return !["waiting", "result"].includes(room.phase); }
function leaveRoom(pid, silent = false) {
  const p = people.get(pid); if (!p?.room) return;
  const room = rooms.get(p.room); p.room = null;
  io.sockets.sockets.get(p.socketId)?.leave(room?.code);
  if (!room) return;
  const i = idxOf(room, pid);
  if (i < 0) return;
  if (activePhase(room) && room.players.length === 2) forfeit(room, i);
  room.players.splice(i, 1);
  if (!humans(room).length) { clearTimeout(room.timer); room.seq++; rooms.delete(room.code); return; }
  if (room.phase === "result") { room.players.forEach((q) => (q.rematch = false)); room.opponentLeft = true; }
  if (room.phase !== "result") { room.phase = "waiting"; room.endsAt = null; }
  io.to(room.code).emit("opponentLeft");
  broadcast(room);
}

/* ---------- sockets ---------- */
io.on("connection", (socket) => {
  let pid = null;
  const me = () => (pid ? people.get(pid) : null);
  const myRoom = () => { const p = me(); return p?.room ? rooms.get(p.room) : null; };
  const myIdx = () => { const r = myRoom(); return r ? idxOf(r, pid) : -1; };

  socket.on("hello", ({ pid: want, name } = {}, ack) => {
    pid = typeof want === "string" && /^[a-f0-9-]{36}$/.test(want) ? want : crypto.randomUUID();
    const nm = clean(name, 24) || "Debater";
    let p = people.get(pid);
    if (p && p.socketId && p.socketId !== socket.id) io.sockets.sockets.get(p.socketId)?.disconnect(true);
    if (!p) { p = { pid, name: nm, socketId: socket.id, room: null }; people.set(pid, p); }
    p.socketId = socket.id; p.name = nm;
    const room = myRoom();
    if (room) {
      const pl = room.players[idxOf(room, pid)];
      if (pl) { pl.connected = true; pl.name = nm; clearTimeout(pl.forfeitTimer); }
      socket.join(room.code);
      broadcast(room);
      if (humans(room).length === 2 && humans(room).every((h) => h.connected)) io.to(room.code).emit("rtcStart");
    }
    ack?.({ pid, inRoom: Boolean(room) });
  });

  socket.on("setName", (name) => {
    const p = me(); if (!p) return; p.name = clean(name, 24) || "Debater";
    const r = myRoom(); if (r) { const pl = r.players[myIdx()]; if (pl) pl.name = p.name; broadcast(r); }
  });

  socket.on("quickMatch", () => {
    if (!pid) return; leaveRoom(pid, true);
    queue = queue.filter((q) => q !== pid && people.get(q)?.socketId && io.sockets.sockets.get(people.get(q).socketId));
    const partner = queue.shift();
    if (!partner) { queue.push(pid); socket.emit("queued"); return; }
    const room = makeRoom();
    addPlayer(room, partner); addPlayer(room, pid);
    startMatch(room);
    io.to(room.code).emit("rtcStart");
  });
  socket.on("cancelQueue", () => { queue = queue.filter((q) => q !== pid); socket.emit("unqueued"); });

  socket.on("createRoom", (_x, ack) => {
    if (!pid) return; leaveRoom(pid, true); queue = queue.filter((q) => q !== pid);
    const room = makeRoom({ isPrivate: true }); addPlayer(room, pid); broadcast(room); ack?.({ code: room.code });
  });
  socket.on("joinRoom", (c, ack) => {
    if (!pid) return;
    const room = rooms.get(String(c || "").toUpperCase().trim());
    if (!room || room.bot) return ack?.({ error: "No room with that code." });
    if (idxOf(room, pid) >= 0) { broadcast(room); return ack?.({ ok: true }); }
    if (room.players.length >= 2) return ack?.({ error: "That room is full." });
    leaveRoom(pid, true); queue = queue.filter((q) => q !== pid);
    addPlayer(room, pid); room.opponentLeft = false;
    ack?.({ ok: true });
    startMatch(room);
    io.to(room.code).emit("rtcStart");
  });
  socket.on("playBot", (level) => {
    if (!pid) return; leaveRoom(pid, true); queue = queue.filter((q) => q !== pid);
    const lv = LEVELS[level] ? level : "varsity";
    const room = makeRoom({ bot: lv }); addPlayer(room, pid); addBot(room, lv); startMatch(room);
  });
  socket.on("leaveRoom", () => { if (pid) { leaveRoom(pid); socket.emit("left"); } });

  socket.on("vote", (i) => { const r = myRoom(); if (r?.phase !== "motion") return; const n = Number(i); if (n >= 0 && n < 5) { r.players[myIdx()].vote = n; checkAll(r); } });
  socket.on("sidePick", (s) => { const r = myRoom(); if (r?.phase !== "side" || !["FOR", "AGAINST"].includes(s)) return; r.players[myIdx()].sidePick = s; checkAll(r); });
  socket.on("ready", () => { const r = myRoom(); if (r?.phase !== "prep") return; r.players[myIdx()].ready = true; checkAll(r); });
  socket.on("draft", ({ i, text } = {}) => {
    const r = myRoom(); if (!r || r.phase !== "speech" + i || speakerIdx(r, i) !== myIdx()) return;
    r.drafts[i] = String(text ?? "").slice(0, 4000);
    socket.to(r.code).emit("caption", { i, text: r.drafts[i] });
  });
  socket.on("endSpeech", (i) => { const r = myRoom(); if (r && r.phase === "speech" + i && speakerIdx(r, i) === myIdx()) endSpeech(r, i); });
  socket.on("openLine", (text) => {
    const r = myRoom(); if (r?.phase !== "open") return;
    addOpenLine(r, myIdx(), text);
    if (r.bot) { r.botOpen.lastHuman = now(); later(r, r.seq, 500, () => botReply(r, r.seq)); }
  });
  socket.on("rematch", () => { const r = myRoom(); if (r?.phase !== "result" || r.players.length < 2) return; r.players[myIdx()].rematch = true; checkAll(r); });
  socket.on("rtc", (data) => {
    const r = myRoom(); if (!r || r.bot) return;
    const o = r.players.find((p) => p.pid !== pid && !p.bot); if (!o) return;
    const sid = people.get(o.pid)?.socketId; if (sid) io.to(sid).emit("rtc", data);
  });

  socket.on("disconnect", () => {
    const p = me(); if (!p || p.socketId !== socket.id) return;
    p.socketId = null; queue = queue.filter((q) => q !== pid);
    const room = myRoom(); if (!room) return;
    const pl = room.players[idxOf(room, pid)]; if (!pl) return;
    pl.connected = false; broadcast(room);
    pl.forfeitTimer = setTimeout(() => { if (!pl.connected) leaveRoom(pid); }, FORFEIT_SECONDS * 1000 * TIME_SCALE);
  });
});

server.listen(PORT, () => {
  console.log(`Clash running on http://localhost:${PORT}  (AI: ${AI.label})`);
});
export { server };
