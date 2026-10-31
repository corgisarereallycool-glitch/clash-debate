# Clash — 1v1 quickfire debate

Real-time debating with your friends: vote on a random motion, pick sides, argue out loud in timed rounds, and let an AI judge score you both.

**Completely free to run.** Hosting is free on Render, and the AI judge uses Pollinations, a free AI service that needs no account and no API key. Nothing to sign up for except GitHub and Render.

**How a match works**

1. **Motion vote (15s):** 5 random motions. Same pick → you get it. Different picks → coin flip between the two.
2. **Side pick (10s):** FOR or AGAINST. Different picks → both get their choice. Same pick → randomized.
3. **Prep (20s):** mics off, take notes.
4. **Speeches:** FOR, AGAINST, FOR, AGAINST — two 30-second speeches each. Only the speaker's mic is live.
5. **Open floor (45s):** both mics live, no turn order.
6. **Verdict:** the AI judge scores each debater 0–20 on Logical Consistency, Use of Evidence, Rebuttal Quality, Delivery Clarity and Persuasiveness (total out of 100). Higher total wins.

**Ways to play:** Quick match (pairs whoever is waiting), Play a friend (room code + invite link), Practice vs AI (Novice / Varsity / Champion; the AI talks out loud).

**Voice & captions:** players hear each other live over a peer-to-peer WebRTC connection. Your speech is turned into text with the browser's speech recognition, and that transcript is what the judge reads. You can edit or type it if captions mishear you.

---

## Put it online for free (GitHub + Render)

### 1. Put the code on GitHub
1. Make a free account at github.com.
2. Click **+** (top right) → **New repository**. Name it `clash-debate`, leave it Public, click **Create repository**.
3. Click **uploading an existing file**.
4. Open this `clash` folder and drag everything **inside** it into the page (`server.js`, `package.json`, `ai.js`, `motions.js`, the `public` and `test` folders, `README.md`). `package.json` must be at the top level, not inside a subfolder.
5. Click **Commit changes**.

### 2. Host it on Render
1. Make a free account at render.com (sign up with GitHub).
2. **New +** → **Web Service** → pick `clash-debate`.
3. Runtime **Node** · Build Command `npm install` · Start Command `npm start` · Instance Type **Free**.
4. Click **Create Web Service**. When it says **Live**, your link is at the top, e.g. `https://clash-debate.onrender.com`.

That's it. No environment variables needed. Send the link to your friends.

**Free plan notes:** Render puts a free site to sleep after 15 minutes with no visitors. The next visit takes about a minute to wake it up. You get 750 free hours a month, which covers one site running all month.

**Updating:** upload changed files to GitHub the same way. Render redeploys on its own.

---

## About the free AI judge

The free AI service handles **one request at a time, about 30 seconds apart** for the whole site. The game is built around that:

- The judge always gets a turn. If two matches finish at once, the second waits its turn (up to a minute or so).
- In Practice vs AI, the AI opponent uses the free AI when a turn is open and falls back to built-in speeches when it isn't. Its open-floor comebacks are mostly built-in lines.
- If the free AI is down or doesn't answer, the match still ends with an offline estimate based on length, structure, evidence and direct responses. You'll see "(Offline estimate)" on the result.

**Optional upgrades (still free):**
- **Gemini, free key, no credit card:** get a key at https://aistudio.google.com/apikey and add an environment variable `GEMINI_API_KEY` in Render (Service → Environment). Much higher limits and a stronger judge.
- **Pollinations token:** a free token from https://enter.pollinations.ai removes the 30-second spacing. Add it as `POLLINATIONS_TOKEN`.

Paid option: `ANTHROPIC_API_KEY` uses Claude for the judge and opponent.

## Settings (environment variables, all optional)

| Variable | What it does |
| --- | --- |
| `GEMINI_API_KEY` | Use Google Gemini's free tier for the judge and AI opponent. |
| `GEMINI_MODEL` | Gemini model (default `gemini-2.5-flash`). |
| `POLLINATIONS_TOKEN` | Optional free Pollinations token; removes the 30-second spacing. |
| `ANTHROPIC_API_KEY` | Use Claude (paid). `JUDGE_MODEL` / `BOT_MODEL` pick the models. |
| `AI_PROVIDER` | Force `pollinations`, `gemini`, `anthropic`, or `off` (offline scoring only). |
| `ICE_SERVERS` | JSON array of WebRTC ICE servers. Add a TURN server if voice fails on strict school/work networks, e.g. `[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]`. Metered.ca has a free TURN tier. |
| `PORT` | Port to listen on (Render sets this for you). |
| `TIME_SCALE` | Multiplies every timer. Only for testing. |

Motions live in `motions.js`; edit the list freely.

## Run it on your own computer

Needs [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. Open a second browser window to play yourself. Microphones only work on `localhost` or over https, so friends on other computers need the Render link.

## Tips for players

- **Use Chrome or Edge** for live captions. Safari and Firefox players can still hear and speak; they type their speech instead.
- **Wear headphones,** or your opponent's voice can leak into your captions during the open floor.
- If the mic is blocked, allow it in site settings (lock icon in the address bar) and reload.
- If you refresh or drop, you have 30 seconds to come back before the match counts as a forfeit.

## Project layout

```
server.js        match server: rooms, timers, judging, AI opponent, voice signaling
ai.js            AI providers (free Pollinations by default, optional Gemini or Claude)
motions.js       the motion list
public/          the web page (index.html, style.css, app.js)
test/            end-to-end test: npm test
```
