# Handshake

In-person buyer check on Even Realities G2. Type your company once; Handshake reads your website and works out who your customers are and which roles inside them buy. At an event, someone introduces themselves, you click the ring, and the glasses show whether they're a fit, which buyer role they match, one line of why, and a suggested opener. One more click saves the lead.

Built for the Heads Up hackathon (Even Realities x TVM Ventures x Daos Hub), Track 04: AI Assistants & Work. The idea and plan are in [docs/idea.md](docs/idea.md).

## Run

One-time setup (macOS):

```bash
npm install
cp backend/.env.example backend/.env   # add OPENAI_API_KEY (and TREG_API_KEY, optional)
brew install whisper.cpp
mkdir -p backend/models && curl -L -o backend/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

Then, in four terminals:

```bash
npm run whisper    # local speech-to-text server on :8178
npm run backend    # Handshake backend on :8787 (POST /lookup)
npm run dev        # Vite dev server on :5173
npm run simulate   # Even Hub simulator, automation API on :9898
```

Open http://localhost:5173 (the phone screen of the app), type your company or its website and press **Build**. The profile is saved to `backend/data/profile.json` (git-ignored). Until you build one, cards are judged against the sample `backend/icp.md`.

Real glasses: `npx evenhub qr --url http://<your-ip>:5173` and scan with the Even Realities app.

Package: `npm run pack` produces an `.ehpk`.

## Repeatable simulator runs

`npm run dev` serves a dev-only fixture mode: open the simulator at `http://localhost:5173/?fixture=sarah-stripe` and a tap plays `backend/fixtures/sarah-stripe.wav` through the same capture and lookup as the mic.

## Latency check

`npm run fixtures` generates sample introductions (clean and with background noise) in `backend/fixtures/`. `npm run bench` sends each one to the backend and prints the transcript, the card and the time per step. Add your own 16 kHz mono WAV recordings there for more honest numbers.

## How it works

**Setup (phone):** company name or website → Treg looks up the company (domain, industry, size) while the backend reads the homepage → OpenAI turns that into a profile: problem, solution, ideal customer companies, three buyer roles with real job titles, and who is not a fit. About 5-6 s.

**At the event (glasses):** tap → the glasses mic records until the person stops talking (or you tap again) → the clip goes to the backend → Whisper transcribes it → OpenAI judges the transcript against the profile and returns a card → the glasses show the card with **Save lead** / **Skip**. Double-tap goes back, or exits from the home screen. Audio stays in memory for the request and is never stored.

**Role check (second pass, about 2-4 s later):** with a Treg token, the backend looks up the company (by the domain the scorer is confident about, or an exact name match), searches its people by the name and role heard, and fuzzy-matches the name ("Kari Saarinen" heard, "Karri Saarinen" found). A database title is only shown as **Verified** when it fits what the person said, so a different person with the same name is ignored. If they aren't a buyer but their company fits, it finds who holds the main buyer role there ("Buyer there: Reema Doshi (RevOps lead)", "Ask: Could you intro me to Reema?"). The scorer then runs again with these facts, keeping its first verdict unless they give a reason to change it, and the glasses update the card in place.

Speech-to-text defaults to OpenAI `gpt-4o-transcribe` because it gets names right far more often than local Whisper base, and the role check depends on the name. Set `STT=whisper` for the free, offline path.

Without an OpenAI key the scorer is a placeholder that only pulls out the name and company.

Treg is used only for work information (what a company does, who holds a role there), never personal contact details.

## Disclosure

This repo was started on Nov 19, 2026 from the official Even Hub `minimal` template (setup and a one-line smoke test only). Before the hackathon, a separate throwaway spike explored the idle → listening → card → Save/Skip flow in the simulator with a mock backend. All feature code in this repo is written during build week (Nov 23-29, 2026).
