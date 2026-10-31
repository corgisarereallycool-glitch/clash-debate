/* Clash client: renders server state, runs voice (WebRTC) and live captions (Web Speech API). */
"use strict";
const ORDER = [{side:"FOR",round:1},{side:"AGAINST",round:1},{side:"FOR",round:2},{side:"AGAINST",round:2}];
const CRITERIA = [
  {k:"logical",name:"Logical Consistency"},{k:"evidence",name:"Use of Evidence"},{k:"rebuttal",name:"Rebuttal Quality"},
  {k:"delivery",name:"Delivery Clarity"},{k:"persuasion",name:"Persuasiveness"}];
const RAIL = [["home","Lobby"],["motion","Motion"],["side","Sides"],["prep","Prep"],["r1","Round 1"],["r2","Round 2"],["open","Open floor"],["verdict","Verdict"]];
let ICE = [{urls:["stun:stun.l.google.com:19302","stun:stun1.l.google.com:19302"]}];
fetch("/config").then((r) => r.json()).then((c) => { if (Array.isArray(c.iceServers)) ICE = c.iceServers; }).catch(() => {});

/* ---------- helpers ---------- */
const $ = (s) => document.querySelector(s);
const stage = $("#stage");
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v; else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
             set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const words = (t) => (String(t).trim().match(/\S+/g) || []).length;
const other = (s) => (s === "FOR" ? "AGAINST" : "FOR");

/* ---------- identity & record ---------- */
let pid = ls.get("clash.pid", null);
let myName = ls.get("clash.name", "");
const record = ls.get("clash.record", { w: 0, l: 0, d: 0, seen: [] });
function showRecord() { $("#record").textContent = `${record.w}W · ${record.l}L · ${record.d}D`; }
showRecord();

/* ---------- state ---------- */
const socket = io({ transports: ["websocket", "polling"] });
let st = null, offset = 0, screenKey = null, screen = null, queued = false;
let prepNotes = "", captions = {}, toast = "";
const me = () => st?.players[st.you];
const opp = () => st?.players[1 - st.you];
const mySide = () => me()?.side;
const serverNow = () => Date.now() + offset;
const urlRoom = new URLSearchParams(location.search).get("room");

socket.on("connect", () => {
  socket.emit("hello", { pid, name: myName || "Debater" }, (r) => {
    pid = r.pid; ls.set("clash.pid", pid);
    if (!r.inRoom) { st = null; render(); }
  });
});
socket.on("disconnect", () => status());
socket.on("state", (s) => {
  const prevPhase = st?.phase;
  st = s; offset = s.serverNow - Date.now(); queued = false;
  if (prevPhase !== s.phase) { try { speechSynthesis.cancel(); } catch {} }
  render(); mic.sync();
});
socket.on("queued", () => { queued = true; render(); });
socket.on("unqueued", () => { queued = false; render(); });
socket.on("left", () => { st = null; rtc.close(); render(); mic.sync(); });
socket.on("opponentLeft", () => { toast = "Your opponent left."; rtc.close(); });
socket.on("caption", ({ i, text }) => { captions[i] = text; screen?.caption?.(i, text); });
socket.on("openLine", (line) => screen?.openLine?.(line));
socket.on("botSay", ({ text }) => speak(text));
socket.on("rtcStart", () => rtc.start());
socket.on("rtc", (d) => rtc.handle(d));

/* ---------- AI voice (text to speech for the AI opponent) ---------- */
function speak(text) {
  try {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.08; u.pitch = 1;
    const v = speechSynthesis.getVoices().find((v) => /en[-_]/i.test(v.lang) && /natural|google|samantha|daniel/i.test(v.name));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch {}
}

/* ---------- microphone ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const micBtn = $("#micBtn");
const mic = {
  stream: null, state: "off", muted: false,
  async ensure() {
    if (this.stream) return true;
    if (!navigator.mediaDevices?.getUserMedia) { this.state = "blocked"; this.ui(); return false; }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      this.state = "ready"; rtc.attach();
    } catch { this.state = "blocked"; }
    this.sync(); return !!this.stream;
  },
  canTalk() {
    if (!st) return false;
    const ph = st.phase;
    if (ph === "open") return true;
    if (ph.startsWith("speech")) return ORDER[st.speechIndex]?.side === mySide();
    if (ph === "prep" || ph === "judging") return false;
    return !st.vsBot; // lobby chatter with a human opponent
  },
  live() { return !!this.stream && !this.muted && this.canTalk(); },
  sync() {
    const live = this.live();
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = live));
    stt.sync(); this.ui();
  },
  ui() {
    micBtn.hidden = !st;
    micBtn.className = "mic " + (this.state === "blocked" ? "blocked" : this.live() ? "live" : "off");
    micBtn.textContent = this.state === "blocked" ? "Mic blocked" : !this.stream ? "Enable mic" : this.muted ? "Muted" : this.live() ? "Mic live" : "Mic waiting";
    micBtn.setAttribute("aria-pressed", String(this.live()));
    micBtn.title = this.state === "blocked" ? "Allow microphone access in your browser's site settings, then reload." : "Your mic only goes live when it's your turn to talk.";
    status();
  },
};
micBtn.onclick = async () => { if (!mic.stream) await mic.ensure(); else { mic.muted = !mic.muted; mic.sync(); } };

/* ---------- live captions ---------- */
let sttBlocked = false;
const stt = {
  rec: null, mode: null, want: false, interim: "",
  targetMode() {
    if (!st) return null;
    if (st.phase === "open") return "open";
    if (st.phase.startsWith("speech") && ORDER[st.speechIndex]?.side === mySide()) return "speech" + st.speechIndex;
    return null;
  },
  sync() {
    const m = this.targetMode();
    if (m !== this.mode) { this.stop(); this.mode = m; this.interim = ""; }
    this.want = !!(m && SR && mic.stream && !mic.muted && !sttBlocked);
    if (this.want && !this.rec) this.start();
    if (!this.want) this.stop();
  },
  start() {
    const r = new SR();
    r.continuous = true; r.interimResults = true; r.lang = navigator.language || "en-US";
    const mode = this.mode;
    r.onresult = (e) => {
      if (this.mode !== mode) return;
      let interim = "";
      for (let k = e.resultIndex; k < e.results.length; k++) {
        const res = e.results[k];
        if (res.isFinal) onFinal(res[0].transcript.trim()); else interim += res[0].transcript;
      }
      this.interim = interim; screen?.interim?.(interim);
    };
    r.onerror = (e) => { if (e.error === "not-allowed" || e.error === "service-not-allowed") { sttBlocked = true; this.want = false; status(); } };
    r.onend = () => { if (this.rec === r) this.rec = null; if (this.want) setTimeout(() => this.sync(), 200); };
    try { r.start(); this.rec = r; } catch { this.rec = null; }
  },
  stop() { const r = this.rec; this.rec = null; if (r) { r.onend = null; try { r.stop(); } catch {} } },
};
function onFinal(text) {
  if (!text) return;
  if (stt.mode === "open") socket.emit("openLine", text);
  else screen?.appendFinal?.(text);
}

/* ---------- voice chat (WebRTC, peer to peer) ---------- */
const remoteAudio = $("#remoteAudio");
const rtc = {
  pc: null, tx: null, pending: [], state: "idle",
  close() { try { this.pc?.close(); } catch {} this.pc = null; this.tx = null; this.pending = []; this.state = "idle"; remoteAudio.srcObject = null; status(); },
  create() {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    pc.onicecandidate = (e) => { if (e.candidate) socket.emit("rtc", { ice: e.candidate }); };
    pc.ontrack = (e) => { remoteAudio.srcObject = e.streams[0] || new MediaStream([e.track]); remoteAudio.play().catch(() => { this.needsTap = true; status(); }); };
    pc.onconnectionstatechange = () => { this.state = pc.connectionState; status(); };
    this.pc = pc; this.state = "connecting"; status();
    return pc;
  },
  attach() { const t = mic.stream?.getAudioTracks()[0]; if (this.tx && t) this.tx.sender.replaceTrack(t).catch(() => {}); },
  async start() {
    this.close();
    if (!st || st.vsBot || st.you !== 0) return; // player 0 makes the offer; player 1 waits for it
    const pc = this.create();
    this.tx = pc.addTransceiver("audio", { direction: "sendrecv" });
    this.attach();
    await pc.setLocalDescription(await pc.createOffer());
    socket.emit("rtc", { sdp: pc.localDescription });
  },
  async handle(d) {
    try {
      if (d.sdp?.type === "offer") {
        this.close();
        const pc = this.create();
        await pc.setRemoteDescription(d.sdp);
        this.tx = pc.getTransceivers()[0]; if (this.tx) this.tx.direction = "sendrecv";
        this.attach();
        await pc.setLocalDescription(await pc.createAnswer());
        socket.emit("rtc", { sdp: pc.localDescription });
        this.flush();
      } else if (d.sdp?.type === "answer" && this.pc) {
        await this.pc.setRemoteDescription(d.sdp); this.flush();
      } else if (d.ice) {
        if (this.pc?.remoteDescription) await this.pc.addIceCandidate(d.ice).catch(() => {});
        else this.pending.push(d.ice);
      }
    } catch (e) { console.warn("voice setup", e); }
  },
  flush() { const p = this.pending; this.pending = []; p.forEach((c) => this.pc?.addIceCandidate(c).catch(() => {})); },
};
document.addEventListener("click", () => { if (rtc.needsTap) { remoteAudio.play().then(() => { rtc.needsTap = false; status(); }).catch(() => {}); } });

/* ---------- status line ---------- */
function status() {
  const s = $("#status"); s.innerHTML = "";
  const bits = [];
  let cls = "ok";
  if (!socket.connected) { cls = "warn"; bits.push("Reconnecting to the server…"); }
  else if (st) {
    if (!st.vsBot && st.players.length === 2) {
      const v = rtc.state === "connected" ? "Voice connected" : rtc.state === "failed" ? "Voice couldn't connect (strict network). Captions still work." : "Connecting voice…";
      if (rtc.state !== "connected") cls = "warn";
      bits.push(v);
    }
    if (rtc.needsTap) { cls = "warn"; bits.push("Tap anywhere to hear your opponent."); }
    if (!SR) bits.push("Live captions need Chrome or Edge; type your speech instead.");
    else if (sttBlocked) bits.push("Captions are blocked; type your speech instead.");
    if (!st.ai) bits.push("AI judge offline on this server (estimated scores).");
  } else bits.push("Connected. Headphones recommended so your opponent's voice doesn't end up in your captions.");
  s.append(el("span", { class: "dot " + cls }), el("span", { text: bits.join(" · ") }));
}

/* ---------- timer ---------- */
function timerEl() {
  const total = st.endsAt ? Math.max(1, st.endsAt - serverNow()) : 1;
  const clock = el("div", { class: "clock" }), fill = el("i");
  const w = el("div", { class: "timer", role: "timer" }, clock, el("div", { class: "bar" }, fill));
  w._tick = () => {
    if (!st?.endsAt) return;
    const left = Math.max(0, (st.endsAt - serverNow()) / 1000);
    clock.textContent = Math.ceil(left); clock.classList.toggle("low", left <= 5);
    fill.style.width = Math.min(100, (left * 1000 / total) * 100) + "%";
  };
  w._tick(); w.classList.add("live-timer");
  return w;
}
setInterval(() => document.querySelectorAll(".live-timer").forEach((t) => t._tick()), 100);

/* ---------- rail ---------- */
function rail(cur) {
  const r = $("#rail"); r.innerHTML = ""; const idx = RAIL.findIndex((p) => p[0] === cur);
  RAIL.forEach(([, l], i) => r.append(el("span", { class: i === idx ? "on" : i < idx ? "done" : "", text: l })));
}
function railKey() {
  if (!st || st.phase === "waiting") return "home";
  const ph = st.phase;
  if (ph.startsWith("motion")) return "motion";
  if (ph.startsWith("side")) return "side";
  if (ph === "prep") return "prep";
  if (ph.startsWith("speech")) return "r" + ORDER[st.speechIndex].round;
  if (ph === "open") return "open";
  return "verdict";
}

/* ---------- render ---------- */
function render() {
  const key = !st ? (queued ? "queue" : urlRoom ? "join:" + urlRoom : "home") : `${st.code}:${st.matchNo}:${st.phase}:${st.players.length}`;
  rail(railKey());
  if (key !== screenKey) {
    screenKey = key; stage.innerHTML = "";
    screen = buildScreen();
    if (screen?.el) stage.append(screen.el);
  }
  screen?.update?.();
  mic.ui();
}
function buildScreen() {
  if (!st) return queued ? queueScreen() : urlRoom ? joinScreen() : homeScreen();
  const ph = st.phase;
  if (ph === "waiting") return waitingScreen();
  if (ph === "motion") return motionScreen();
  if (ph === "motionReveal") return motionRevealScreen();
  if (ph === "side") return sideScreen();
  if (ph === "sideReveal") return sideRevealScreen();
  if (ph === "prep") return prepScreen();
  if (ph.startsWith("speech")) return ORDER[st.speechIndex].side === mySide() ? mySpeechScreen() : theirSpeechScreen();
  if (ph === "open") return openScreen();
  if (ph === "judging") return judgingScreen();
  if (ph === "result") return resultScreen();
  return { el: el("p", { text: "…" }) };
}
const frag = (...k) => el("div", { style: "display:contents" }, ...k);
const oppLabel = () => (opp() ? (opp().bot ? opp().name : "@" + opp().name) : "your opponent");
function sideTag(side, prefix = "") { return el("span", { class: "tag " + side, text: prefix + side }); }
function pill(on, onText, offText) { return el("span", { class: "pill" + (on ? " ok" : ""), text: on ? onText : offText }); }

/* ---------- screens: lobby ---------- */
function nameField() {
  const input = el("input", { type: "text", id: "name", maxlength: "24", placeholder: "Your name", value: myName, "aria-label": "Your name" });
  input.addEventListener("change", () => { myName = input.value.trim().slice(0, 24); ls.set("clash.name", myName); socket.emit("setName", myName || "Debater"); });
  return input;
}
function needName(input) {
  myName = input.value.trim().slice(0, 24);
  if (!myName) { input.focus(); input.placeholder = "Pick a name first"; return false; }
  ls.set("clash.name", myName); socket.emit("setName", myName); return true;
}
function homeScreen() {
  const name = nameField();
  const code = el("input", { type: "text", id: "code", class: "code-input", maxlength: "4", placeholder: "CODE", "aria-label": "Room code" });
  const err = el("p", { class: "muted", text: "" });
  const level = el("select", { id: "level", "aria-label": "AI level" },
    [["novice", "Novice"], ["varsity", "Varsity"], ["champion", "Champion"]].map(([v, l]) => el("option", { value: v, text: l, selected: v === ls.get("clash.level", "varsity") })));
  const go = async (fn) => { if (!needName(name)) return; await mic.ensure(); fn(); };
  return { el: frag(
    el("div", { class: "eyebrow", text: "1v1 quickfire debate" }),
    el("h1", { text: "Thirty seconds to win the room." }),
    el("p", { class: "muted", text: "Vote on a random motion, pick your side, then argue it out loud in timed rounds. Your words become live captions, and an AI judge scores both of you on a competition rubric. Higher total wins. No appeals." }),
    el("div", { class: "row" }, name),
    el("div", { class: "modes" },
      el("div", { class: "mode" }, el("h3", { text: "Quick match" }), el("p", { text: "Get paired with whoever else is waiting." }),
        el("div", { class: "row" }, el("button", { class: "primary", onclick: () => go(() => socket.emit("quickMatch")) }, "Find a match"))),
      el("div", { class: "mode" }, el("h3", { text: "Play a friend" }), el("p", { text: "Make a room and send the code or link." }),
        el("div", { class: "row" }, el("button", { class: "primary", onclick: () => go(() => socket.emit("createRoom", null, () => {})) }, "Create room")),
        el("div", { class: "row" }, code, el("button", { onclick: () => go(() => socket.emit("joinRoom", code.value, (r) => { if (r?.error) err.textContent = r.error; })) }, "Join")), err),
      el("div", { class: "mode" }, el("h3", { text: "Practice vs AI" }), el("p", { text: "The AI speaks its speeches out loud. Good for warming up." }),
        el("div", { class: "row" }, level, el("button", { class: "primary", onclick: () => go(() => { ls.set("clash.level", level.value); socket.emit("playBot", level.value); }) }, "Start")))),
    el("div", { class: "fmt" },
      el("div", {}, el("b", { text: "20s" }), "Prep time"), el("div", {}, el("b", { text: "2 × 30s" }), "Speeches each"),
      el("div", {}, el("b", { text: "45s" }), "Open floor, no turns"), el("div", {}, el("b", { text: "/100" }), "Judge's total")),
    el("div", { class: "eyebrow", text: "The judge's rubric · 20 points each" }),
    el("div", { class: "rubric" }, CRITERIA.map((c) => el("div", {}, c.name, el("span", { text: "0–20" })))),
  ) };
}
function joinScreen() {
  const name = nameField(); const err = el("p", { class: "muted" });
  return { el: frag(
    el("div", { class: "eyebrow", text: "You've been invited" }),
    el("h2", {}, "Join room ", el("span", { class: "bigcode", style: "font-size:inherit", text: urlRoom.toUpperCase() })),
    el("p", { class: "muted", text: "Allow your microphone when asked. Headphones help." }),
    el("div", { class: "row" }, name, el("button", { class: "primary", onclick: async () => {
      if (!needName(name)) return; await mic.ensure();
      socket.emit("joinRoom", urlRoom, (r) => { if (r?.error) err.textContent = r.error; else history.replaceState(null, "", "/"); });
    } }, "Join match"), el("button", { onclick: () => { history.replaceState(null, "", "/"); location.reload(); } }, "Not now")), err) };
}
function queueScreen() {
  return { el: frag(el("div", { class: "eyebrow", text: "Quick match" }), el("h2", { class: "pulse", text: "Looking for an opponent…" }),
    el("p", { class: "muted", text: "You'll be matched with the next person who hits Find a match. Leave this tab open." }),
    el("div", { class: "row" }, el("button", { onclick: () => socket.emit("cancelQueue") }, "Cancel"))) };
}
function waitingScreen() {
  const link = `${location.origin}/?room=${st.code}`;
  const copy = el("button", { onclick: () => { navigator.clipboard?.writeText(link).then(() => (copy.textContent = "Copied"), () => {}); } }, "Copy invite link");
  const t = toast; toast = "";
  return { el: frag(
    t ? el("p", { class: "tag gold", text: t }) : null,
    el("div", { class: "eyebrow", text: "Room code" }), el("div", { class: "bigcode", text: st.code }),
    el("p", { class: "muted", text: "Send the code or the link to a friend. The match starts the moment they join." }),
    el("div", { class: "row" }, el("input", { type: "text", readonly: true, value: link, style: "flex:1", "aria-label": "Invite link" }), copy),
    el("h2", { class: "pulse", text: "Waiting for your opponent…" }),
    el("div", { class: "row" }, el("button", { onclick: () => socket.emit("leaveRoom") }, "Leave room"))) };
}

/* ---------- screens: motion & sides ---------- */
function versus() {
  return el("div", { class: "vs" }, el("span", { text: me()?.name + " (you)" }), el("span", { class: "muted", text: "vs" }), el("span", { text: oppLabel() }),
    opp() && !opp().connected ? el("span", { class: "pill", text: "reconnecting…" }) : null);
}
function motionScreen() {
  const btns = st.motions.map((m, i) => el("button", { class: "pick", onclick: () => socket.emit("vote", i) }, el("span", { class: "n", text: "0" + (i + 1) }), el("span", { text: m })));
  const p = el("span");
  return { el: frag(versus(), el("div", { class: "eyebrow", text: "Vote for a motion" }),
      el("p", { class: "muted", text: "Same pick and you get it. Different picks and it's a coin flip between the two." }),
      timerEl(), el("div", { class: "picks" }, btns), el("div", { class: "row" }, p)),
    update() { btns.forEach((b, i) => b.classList.toggle("sel", me().vote === i)); p.replaceChildren(pill(opp()?.voted, oppLabel() + " has voted", oppLabel() + " is choosing…")); } };
}
function motionRevealScreen() {
  const mv = me().vote, ov = opp().vote;
  return { el: frag(el("div", { class: "eyebrow", text: "Votes are in" }),
    el("div", { class: "reveal" },
      el("div", {}, el("div", { class: "eyebrow", text: "You picked" }), el("p", { class: "motion-small", text: st.motions[mv] })),
      el("div", {}, el("div", { class: "eyebrow", text: oppLabel() + " picked" }), el("p", { class: "motion-small", text: st.motions[ov] }))),
    el("p", { class: "muted", text: st.motionNote }), el("div", { class: "eyebrow", text: "The motion" }), el("p", { class: "motion", text: st.motion })) };
}
function sideScreen() {
  const mk = (s) => el("button", { class: "sidebtn " + s, onclick: () => socket.emit("sidePick", s) }, s);
  const f = mk("FOR"), a = mk("AGAINST"); const p = el("span");
  return { el: frag(versus(), el("div", { class: "eyebrow", text: "Pick a side" }), el("p", { class: "motion", text: st.motion }),
      el("p", { class: "muted", text: "Different picks: you both get your choice. Same pick: sides are randomized." }),
      timerEl(), el("div", { class: "sides" }, f, a), el("div", { class: "row" }, p)),
    update() { f.classList.toggle("sel", me().sidePick === "FOR"); a.classList.toggle("sel", me().sidePick === "AGAINST");
      p.replaceChildren(pill(opp()?.picked, oppLabel() + " has picked", oppLabel() + " is choosing…")); } };
}
function sideRevealScreen() {
  return { el: frag(el("div", { class: "eyebrow", text: "Sides locked" }), el("p", { class: "motion-small", text: st.motion }),
    el("div", { class: "reveal" },
      el("div", {}, el("div", { class: "eyebrow", text: "You" }), sideTag(mySide())),
      el("div", {}, el("div", { class: "eyebrow", text: oppLabel() }), sideTag(opp().side))),
    el("p", { class: "muted", text: (st.sideNote || "") + " FOR speaks first in each round." })) };
}
function prepScreen() {
  prepNotes = "";
  const notes = el("textarea", { id: "notes", placeholder: "Jot your claims, an example, and what you expect them to say…" });
  notes.addEventListener("input", () => (prepNotes = notes.value));
  const ready = el("button", { class: "primary", onclick: () => socket.emit("ready") }, "I'm ready");
  const p = el("span");
  setTimeout(() => notes.focus(), 50);
  return { el: frag(el("div", { class: "speaker" }, el("div", { class: "eyebrow", text: "Prep time · mics off" }), sideTag(mySide(), "You argue ")),
      el("p", { class: "motion", text: st.motion }), timerEl(), notes, el("div", { class: "row" }, ready, p)),
    update() { ready.disabled = me().ready; ready.textContent = me().ready ? "Ready" : "I'm ready"; p.replaceChildren(pill(opp()?.ready, oppLabel() + " is ready", oppLabel() + " is still prepping")); } };
}

/* ---------- screens: speeches ---------- */
function speechHead(mine) {
  const o = ORDER[st.speechIndex];
  return el("div", { class: "speaker" },
    el("div", {}, el("div", { class: "eyebrow", text: `Round ${o.round} of 2 · Speech ${st.speechIndex + 1} of 4` }), el("h2", { text: mine ? "Your speech. Talk." : oppLabel() + " is speaking" })),
    sideTag(o.side));
}
function transcriptBox() {
  const items = (st.speeches || []).filter(Boolean).map((s) => el("div", { class: "bubble " + s.side },
    el("div", { class: "eyebrow", text: `${s.side} · Round ${s.round} · ${s.side === mySide() ? "You" : oppLabel()}` }), el("div", { text: s.text || "(no speech delivered)" })));
  return items.length ? el("details", {}, el("summary", { text: `Transcript so far (${items.length})` }), el("div", { class: "tx" }, items)) : null;
}
function mySpeechScreen() {
  const i = st.speechIndex;
  const ta = el("textarea", { id: "speech" + i, placeholder: SR ? "Start talking. Your words appear here, and you can fix them by typing." : "Your browser can't caption speech. Type your speech here." });
  const interim = el("div", { class: "interim", "aria-live": "polite" });
  const cnt = el("span", { class: "count", text: "0 words" });
  const live = el("div", { class: "livebar" }, el("span", { class: "dot" }), el("span", { text: "" }));
  let sendT = null;
  const send = () => { clearTimeout(sendT); sendT = setTimeout(() => socket.emit("draft", { i, text: (ta.value + " " + stt.interim).trim() }), 200); cnt.textContent = words(ta.value + " " + stt.interim) + " words"; };
  ta.addEventListener("input", send);
  const end = el("button", { class: "primary", onclick: () => {
    if (stt.interim) { ta.value = (ta.value + " " + stt.interim).trim(); stt.interim = ""; }
    socket.emit("draft", { i, text: ta.value }); socket.emit("endSpeech", i); end.disabled = true; } }, "End speech");
  const notes = prepNotes ? el("details", {}, el("summary", { text: "Your prep notes" }), el("div", { class: "bubble", style: "min-height:0;margin-top:8px", text: prepNotes })) : null;
  return { el: frag(speechHead(true), el("p", { class: "motion-small", text: st.motion }), timerEl(), live, ta, interim,
      el("div", { class: "speaker" }, cnt, end), notes, transcriptBox()),
    appendFinal(t) { ta.value = (ta.value ? ta.value + " " : "") + t; interim.textContent = ""; stt.interim = ""; send(); ta.scrollTop = ta.scrollHeight; },
    interim(t) { interim.textContent = t; send(); },
    update() {
      const on = !!stt.rec;
      live.firstChild.className = "dot" + (on ? " ok" : "");
      live.lastChild.textContent = on ? "Listening. Your opponent hears you live." : !mic.stream ? "Mic off. Enable it at the top, or type." : mic.muted ? "You're muted. Type, or unmute at the top." : SR && !sttBlocked ? "Starting captions…" : "Type your speech.";
    },
    update0() { this.update(); },
  };
}
function theirSpeechScreen() {
  const i = st.speechIndex, o = ORDER[i];
  const body = el("div", { class: "thinking", text: opp()?.bot ? "Gathering their thoughts…" : "Listening… captions appear as they talk." });
  const bubble = el("div", { class: "bubble " + o.side }, body);
  if (captions[i]) { body.className = ""; body.textContent = captions[i]; }
  return { el: frag(speechHead(false), el("p", { class: "motion-small", text: st.motion }), timerEl(), bubble,
      el("p", { class: "muted", text: "Your mic is off while they speak. Note what to rebut." }), transcriptBox()),
    caption(ci, text) { if (ci !== i) return; body.className = ""; body.textContent = text; } };
}

/* ---------- screens: open floor ---------- */
function openScreen() {
  const log = el("div", { class: "log", role: "log", "aria-live": "polite" });
  const add = (m) => { const mine = m.who === st.you; log.append(el("div", { class: "msg " + (mine ? "me" : "them") }, el("small", { text: mine ? "You" : oppLabel() }), m.text)); log.scrollTop = log.scrollHeight; };
  (st.open || []).forEach(add);
  const input = el("input", { type: "text", id: "chat", placeholder: "Talk, or type here and press Enter", autocomplete: "off", maxlength: "400" });
  const send = () => { const v = input.value.trim(); if (!v) return; input.value = ""; socket.emit("openLine", v); };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); send(); } });
  const interim = el("div", { class: "interim" });
  return { el: frag(el("div", { class: "speaker" }, el("div", {}, el("div", { class: "eyebrow", text: "Open floor · both mics live" }), el("h2", { text: "No rules, no turn order" })), sideTag(mySide(), "You: ")),
      el("p", { class: "motion-small", text: st.motion }), timerEl(), log, interim,
      el("div", { class: "chatbar" }, input, el("button", { class: "primary", onclick: send }, "Send")), transcriptBox()),
    openLine: add, interim(t) { interim.textContent = t; }, appendFinal() {} };
}

/* ---------- screens: verdict ---------- */
function judgingScreen() {
  return { el: frag(el("div", { class: "eyebrow", text: "Verdict" }), el("h2", { class: "pulse", text: "The judge is scoring both debaters…" }),
    el("p", { class: "muted", text: "Five criteria, 20 points each. Higher total wins. The free judge can take up to a minute." })) };
}
function resultScreen() {
  const R = st.result, mySd = mySide(), opSd = other(mySd);
  let out;
  if (R.forfeit) out = R.forfeit.winner === st.you ? "win" : "loss";
  else out = R.winner === mySd ? "win" : R.winner ? "loss" : "draw";
  const tag = `${st.code}:${st.matchNo}`;
  if (!record.seen.includes(tag)) { record.seen = [...record.seen.slice(-50), tag]; record[out === "win" ? "w" : out === "loss" ? "l" : "d"]++; ls.set("clash.record", record); showRecord(); }

  const parts = [el("div", { class: "eyebrow", text: "Verdict · " + st.motion }),
    el("div", { class: "verdict" + (out === "win" ? " win" : ""), text: out === "win" ? "You win." : out === "loss" ? "You lose." : "Dead heat." })];
  if (R.forfeit) parts.push(el("p", { class: "muted", text: out === "win" ? "Your opponent left the match. Win by forfeit." : "You left the match." }));
  else {
    const me_ = R.scores[mySd], op_ = R.scores[opSd], tm = R.totals[mySd], tt = R.totals[opSd];
    parts.push(el("p", { class: "muted", text: `${tm} to ${tt}.${R.offline ? " (Offline estimate.)" : ""}` }));
    const col = (s) => `var(--${s === "FOR" ? "for" : "against"})`;
    const cell = (v, o, sd) => { const i = el("i"); i.style.width = (v / 20) * 100 + "%"; i.style.background = col(sd);
      return el("td", { class: "num" + (v > o ? " best" : "") }, String(v), el("div", { class: "mini" }, i)); };
    parts.push(el("div", { class: "board" }, el("table", {},
      el("thead", {}, el("tr", {}, el("th", { text: "Criterion" }), el("th", {}, "You ", sideTag(mySd)), el("th", {}, oppLabel() + " ", sideTag(opSd)))),
      el("tbody", {}, CRITERIA.map((c) => el("tr", {}, el("td", { text: c.name }), cell(me_[c.k], op_[c.k], mySd), cell(op_[c.k], me_[c.k], opSd))),
        el("tr", { class: "total" }, el("td", { text: "Total" }), el("td", { text: String(tm) }), el("td", { text: String(tt) }))))));
    if (R.summary) parts.push(el("div", {}, el("h3", { text: "Judge's decision" }), el("p", { text: R.summary })));
    const n = R.notes?.[mySd];
    if (n) parts.push(el("div", { class: "notes" }, el("h3", { text: "Your scorecard notes" }),
      CRITERIA.map((c) => (n[c.k] ? el("div", { class: "note" }, el("b", { text: c.name }), el("span", { text: String(n[c.k]) })) : null))));
    const tips = R.tips?.[mySd];
    if (Array.isArray(tips) && tips.length) parts.push(el("div", {}, el("h3", { text: "How to score higher" }), el("ul", { class: "tips" }, tips.slice(0, 4).map((t) => el("li", { text: String(t) })))));
  }
  const rematch = el("button", { class: "primary", onclick: () => socket.emit("rematch") }, "Rematch");
  const rp = el("span");
  parts.push(el("div", { class: "row" }, rematch, el("button", { onclick: () => socket.emit("leaveRoom") }, "Back to lobby"), rp));
  const sp = R.transcript?.speeches || [];
  parts.push(el("details", {}, el("summary", { text: "Full transcript" }), el("div", { class: "tx" },
    sp.filter(Boolean).map((s) => el("div", { class: "bubble " + s.side }, el("div", { class: "eyebrow", text: `${s.side} · Round ${s.round} · ${s.side === mySd ? "You" : oppLabel()}` }), el("div", { text: s.text || "(no speech delivered)" }))),
    (R.transcript?.open || []).length ? el("div", { class: "bubble" }, el("div", { class: "eyebrow", text: "Open floor" }),
      el("div", { text: R.transcript.open.map((m) => `${m.who === st.you ? "You" : oppLabel()}: ${m.text}`).join("\n") })) : null)));
  return { el: frag(...parts),
    update() {
      const o = opp(); const can = st.players.length === 2 && o?.connected;
      rematch.disabled = !can || me()?.rematch; rematch.textContent = me()?.rematch ? "Waiting for them…" : "Rematch";
      rp.replaceChildren(!can ? el("span", { class: "pill", text: "Opponent left" }) : o.rematch && !o.bot ? el("span", { class: "pill ok", text: oppLabel() + " wants a rematch" }) : "");
    } };
}

/* keep the live caption indicator current while speaking */
setInterval(() => { if (screen?.update0) screen.update0(); }, 500);
status();
