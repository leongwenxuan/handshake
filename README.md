# Handshake

In-person ICP check on Even Realities G2. Someone introduces themselves, you click the ring, and the glasses show whether they fit your ICP, one line of why, and a suggested opener. One more click saves the lead.

Built for the Heads Up hackathon (Even Realities x TVM Ventures x Daos Hub), Track 04: AI Assistants & Work. The idea and plan are in [docs/idea.md](docs/idea.md).

## Run

```bash
npm install
npm run dev        # Vite dev server on :5173
npm run simulate   # Even Hub simulator, automation API on :9898
```

Real glasses: `npx evenhub qr --url http://<your-ip>:5173` and scan with the Even Realities app.

Package: `npm run pack` produces an `.ehpk`.

## Disclosure

This repo was started on Nov 19, 2026 from the official Even Hub `minimal` template (setup and a one-line smoke test only). Before the hackathon, a separate throwaway spike explored the idle → listening → card → Save/Skip flow in the simulator with a mock backend. All feature code in this repo is written during build week (Nov 23-29, 2026).
