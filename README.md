# Handshake

In-person ICP check on Even Realities G2. Someone introduces themselves, you click the ring, and the glasses show whether they fit your ICP, one line of why, and a suggested opener. One more click saves the lead.

Built for the Heads Up hackathon (Even Realities x TVM Ventures x Daos Hub), Track 04: AI Assistants & Work. The idea and plan are in [docs/idea.md](docs/idea.md).

## Run

One-time setup (macOS):

```bash
npm install
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

Real glasses: `npx evenhub qr --url http://<your-ip>:5173` and scan with the Even Realities app.

Package: `npm run pack` produces an `.ehpk`.

## Latency check

`npm run fixtures` generates sample introductions (clean and with background noise) in `backend/fixtures/`. `npm run bench` sends each one to the backend and prints the transcript, the card and the time per step. Add your own 16 kHz mono WAV recordings there for more honest numbers.

## How it works

Tap → the glasses mic records until the person stops talking (or you tap again) → the clip goes to the backend → Whisper transcribes it → the scorer turns the transcript into a card → the glasses show the card with **Save lead** / **Skip**. Double-tap goes back, or exits from the home screen. Audio stays in memory for the request and is never stored.

The scorer is a placeholder until a Claude key is configured.

## Disclosure

This repo was started on Nov 19, 2026 from the official Even Hub `minimal` template (setup and a one-line smoke test only). Before the hackathon, a separate throwaway spike explored the idle → listening → card → Save/Skip flow in the simulator with a mock backend. All feature code in this repo is written during build week (Nov 23-29, 2026).
