# Handshake

In-person buyer check on Even Realities G2. Type your company once; Handshake reads your website and works out who your customers are and which roles inside them buy. At an event, someone introduces themselves, you click the ring, and the glasses show whether they're a fit, which buyer role they match, one line of why, and a suggested opener. One more click saves the lead.

Built for the Heads Up hackathon (Even Realities x TVM Ventures x Daos Hub), Track 04: AI Assistants & Work. The idea and plan are in [docs/idea.md](docs/idea.md).

## Run

Needs Node 22.18 or newer (the backend runs its TypeScript directly) and an OpenAI API key. Treg and Notion are optional.

```bash
npm install
cp backend/.env.example backend/.env   # add OPENAI_API_KEY; TREG_API_KEY and NOTION_TOKEN are optional
```

Then, in three terminals:

```bash
npm run backend    # Handshake backend on :8787
npm run dev        # the app (Vite) on :5173
npm run simulate   # Even Hub simulator, automation API on :9898
```

Open http://localhost:5173 (the phone screen of the app), type your company or its website and press **Build**. The profile is saved to `backend/data/profile.json` (git-ignored). Until you build one, cards are judged against the sample `backend/icp.md`. In the simulator, click to start listening and talk into your laptop's mic, or use a fixture (below).

What each key adds:
- `OPENAI_API_KEY`: speech-to-text, the fit verdict, the company profile and the follow-up email. Without it you need local Whisper (see the end of How it works) and the card only shows a name and company.
- `TREG_API_KEY`: company facts during setup, and the role check (verified title, who holds the buyer role).
- `NOTION_TOKEN`: saved leads go to a Notion database (setup below). Without it they're kept in `backend/data/leads.jsonl` and on the phone screen.

**Real glasses on the same wifi:** `npx evenhub qr --url http://<your-laptop-ip>:5173` and scan the code with the Even Realities app. The app calls the backend on the same address at port 8787.

**Packaged app (`.ehpk`):** the backend has to be reachable over HTTPS. Build with its address and add the same origin to the `network` whitelist in `app.json`, then pack:

```bash
VITE_BACKEND_URL=https://your-backend.example.com npm run pack
```

The backend has no login yet: anyone with its address can read saved leads, so don't leave a public one running.

## Repeatable simulator runs

`npm run dev` serves a dev-only fixture mode: open the simulator at `http://localhost:5173/?fixture=sarah-stripe` and a tap plays `backend/fixtures/sarah-stripe.wav` through the same capture and lookup as the mic.

## Latency check

`npm run fixtures` generates sample introductions (clean and with background noise) in `backend/fixtures/`. `npm run bench` sends each one to the backend and prints the transcript, the card and the time per step. Add your own 16 kHz mono WAV recordings there for more honest numbers.

## How it works

**Setup (phone):** your name, and your company name or website → Treg looks up the company (domain, industry, size) while the backend reads the homepage → OpenAI turns that into a profile: problem, solution, ideal customer companies, three buyer roles with real job titles, who is not a fit, and competitors. The phone shows each step as it finishes. About 5-6 s.

**At the event (glasses):** tap → the glasses mic records until the person stops talking (or you tap again) → the clip goes to the backend → OpenAI transcribes it → OpenAI judges the transcript against the profile and returns a card → the glasses show the card: a verdict badge, who they are and what to do next, what to say next, and the reason (dimmed), with **Save lead** / **Skip**. Double-tap goes back, or exits from the home screen. Audio stays in memory for the request and is never stored.

Edge cases at an event:
- You introduce yourself first: speech-to-text is given your name and company as spelling hints, the scorer never scores you, and a clip with only your voice says "Only heard you. Tap again as they start." The glasses also tag each audio chunk with who they think is speaking: when your own intro is tagged as yours, Handshake keeps listening through your pause for the other person and leaves your part out of the clip. When the tags are less clear-cut, the whole clip is sent as before.
- Leaving the app mid-listen (another app or the glasses menu takes over) stops the mic instead of leaving it stuck on "Listening", and anything saved while away is sent on return. The phone's pill shows "Glasses not connected" when the Even app reports them disconnected, and a disconnect mid-listen stops the capture.
- A colleague gets a **COLLEAGUE** card; someone from a company on your competitor list (matched by name or domain in code, not judged by the model, which called almost any company a competitor) gets **COMPETITOR - no pitch** and a question about the market instead of a pitch.
- If the network fails, the clip is kept in memory until your next tap, so **Tap to try again** works without asking them to repeat themselves.
- Two people with the same name at a big company: the role check keeps the one whose title fits what they said, and shows nothing if that doesn't settle it.
- Several people in the buyer role: the most senior is suggested first, with "2/3" on the card. **Other buyer** on the glasses switches to the next one in place (useful when they say "Maya left, talk to Dan"), and Save keeps your pick. On the phone, each lead shows the others plus **No one**; picking one redrafts the email and updates the Notion row.

**Role check (second pass, about 2-4 s later):** with a Treg token, the backend looks up the company (by the domain the scorer is confident about, or an exact name match), searches its people by the name and role heard, and fuzzy-matches the name ("Kari Saarinen" heard, "Karri Saarinen" found). A database title is only shown as **Verified** when it fits what the person said, so a different person with the same name is ignored. If they aren't a buyer but their company fits, it finds who holds the main buyer role there ("Buyer there: Maya Ortiz (RevOps lead)", "Ask: Could you intro me to Maya?"). The scorer then runs again with these facts, keeping its first verdict unless they give a reason to change it, and the glasses update the card in place.

**The verdict is a next step, not a grade.** The scorer judges two things: does their company fit, and are they the buyer. The card turns those into what to do: **Pitch them** (fit and buyer, ✓), **Get an intro** (fit, but someone else buys, →), **Not sure yet** (ask more, ?), **Not a fit** (✕), plus **Competitor** and **Colleague**. The glasses badge, the phone list's groups and the Notion **Fit** column all use the same labels.

**Save:** **Save lead** stores the lead on the glasses at once, then sends it to the backend, which keeps it in `backend/data/leads.jsonl` (git-ignored), drafts a short follow-up email (an intro request when someone else is the buyer, a keep-in-touch note when they're not a fit) and, with a Notion token, adds a row to a **Handshake leads** database with the verdict, verified title, who to ask for, the email draft and what they said. The glasses' home screen confirms when it lands ("Saved Sarah Chen to Notion."). Saving the same person again updates their row and adds the new conversation below the old one, instead of a duplicate. If the backend can't be reached (venue wifi), the glasses keep the lead marked unsent, say "Will sync when back online", and resend it once the backend answers; a resend that had already landed is recognised and not counted twice. Each lead on the phone has **Remove** (tap twice), which deletes it and moves its Notion row to Notion's trash. The phone screen lists **People you met**, grouped by what to do next, with company logos and each email ready to copy or open in Mail. Logos are loaded from DuckDuckGo's icon service by company domain.

Notion setup: create an internal integration at notion.so/profile/integrations, put its secret in `NOTION_TOKEN`, then open any Notion page and add the integration under ••• → Connections. The database is created under that page on the first save.

Speech-to-text defaults to OpenAI `gpt-4o-transcribe` because it gets names right far more often than local Whisper base, and the role check depends on the name. Set `STT=whisper` for the free, offline path: `brew install whisper.cpp`, download the model with `mkdir -p backend/models && curl -L -o backend/models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`, and run `npm run whisper` in a fourth terminal.

Without an OpenAI key the scorer is a placeholder that only pulls out the name and company.

Treg is used only for work information (what a company does, who holds a role there), never personal contact details.

## Disclosure

This repo was started on Nov 19, 2026 from the official Even Hub `minimal` template (setup and a one-line smoke test only). Before the hackathon, a separate throwaway spike explored the idle → listening → card → Save/Skip flow in the simulator with a mock backend. All feature code in this repo is written during build week (Nov 23-29, 2026).
