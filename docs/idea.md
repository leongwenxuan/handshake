# Handshake: in-person ICP check on Even G2

Hackathon: Heads Up (Even Realities x TVM Ventures x Daos Hub, on DoraHacks)
Track: 04 AI Assistants & Work (Claude, Notion, Google Workspace)
Build week: Nov 23-29, 2026. Submission deadline Nov 29, 23:59 Dubai time. Demo Day Dec 3.

## The idea in one line
At an event, someone introduces themselves, you click the ring, and about three seconds later the glasses show whether they fit your ICP, with one line of why and a suggested opener. One more click saves the lead. No phone.

## Why it fits the judging
| Criterion | Weight | How this answers it |
|---|---|---|
| Usefulness on G2 | 30% | Solves a real moment: meeting a stranger and not knowing if they matter |
| Read and write | 25% | Glance at score, one click to save or skip |
| Technical execution | 20% | Mic -> speech-to-text -> Claude -> card, working end to end |
| UX for display and voice | 15% | One short card on 576x288 monochrome, no dictation needed |
| Business potential and safety | 10% | Sales and recruiting at events; professional data only, audio never stored |

## The wow moment
Someone says "Hi, I'm Sarah, I run partnerships at Stripe." You click the ring without saying anything. The glasses show:

    Sarah Chen, Stripe
    STRONG FIT 8/10
    Decides on partnerships, mid-size team
    Ask: "How are you handling X?"

Demo notes: film it in one unbroken take, show a bad fit too (score 3/10, Skip), end by saving a lead. Keep click-to-card under about 3 seconds.

## The problem this solves
Saying a stranger's name aloud into the glasses is awkward. So the main flow lets the other person say their own name:

1. Before the event (optional): import the attendee list, pre-score everyone, and pick from a ranked list with the ring.
2. At the handshake: ring click -> glasses listen about 6 seconds -> Claude extracts name and company and scores them.
3. Backup: dictate the name quietly after walking away, or photograph a badge with the phone camera (needs the phone, so a last resort).

## How it works
    Glasses mic (PCM 16 kHz) -> phone WebView -> your backend -> speech-to-text -> Claude (extract + score vs ICP) -> card on glasses
    Ring: click = start / save; list scroll = Save lead or Skip; double click = back to idle
    Leads: saved in local storage on the device

Rules the design follows: API keys only on the backend, network destinations whitelisted in app.json, CORS handled by the backend, audio captured only after a click and never stored.

## Hardware limits to design around
- Display 576x288, 4-bit greyscale, plain text, about 400-500 characters per full screen
- Lists: up to 20 items, 64 characters each; rebuilding the page is needed to change a list
- No speaker, no glasses camera; one app on screen at a time
- Audio capture stops if the phone app is suspended (an Android risk), so use push-to-talk

## Competition in the Even Hub catalogue
No app found that scores a stranger against an ICP. Nearest:
- IRIS: listens, answers mid-conversation, remembers people you met; no ICP scoring
- Aside: quiet factual answers; stores nothing
- Constella: answers from your own email, notes and meetings (per a third-party roundup, not verified in the store)
- Community: SalesEye, AI Sales Assistant (Salesforce), Cue (conversation coach)

Positioning: IRIS listens passively; this is a deliberate lookup on one person with a fit score and a one-tap save.

## Open questions
1. Are enrichment APIs (for example Treg or Monid) allowed alongside track apps? The rules say "use only the apps listed in your track" and also "existing APIs are allowed". Ask the organizers in the hackathon chat; build so it works without enrichment.
2. Is speech-to-text from a non-track service (for example ElevenLabs) acceptable? The page says to bring your own speech-to-text, so probably yes.
3. What is the real ICP (roles, company size, industries)? The code has a placeholder.
4. Real click-to-card latency with live keys. Unmeasured.

## Status (Nov 19)
A working spike exists: idle -> listening -> card -> Save / Skip in the Even simulator, with a mock backend. Not yet tested with real audio, real Claude or ElevenLabs calls, or real glasses. The rules say to build during the hackathon, so the README discloses the spike.
