# Audia — Business & Idea Overview

## The Idea
A podcast app about anything. Type any topic you're curious about and get a full audio episode in minutes. The more you use it, the more it learns what you're into and suggests content tailored to you. Starts universal, gets personal.

## Name
**Audia** — audio + AI. Says exactly what it is. Sounds clean, premium, and easy to remember.

## Core Loop
1. New user → sees popular/universal trending topics
2. Generates a few episodes → app learns their interests
3. Over time → "For You" suggestions replace generic ones
4. Keeps coming back because it feels made for them

## How It Works (Technical Stack)
- **Frontend:** Single-page React app (`Podcast Studio.html`)
- **Backend:** Node.js / Express server with four pipeline stages:
  1. `search.js` — web search to gather source material
  2. `generate.js` — Claude AI writes a two-host script (hosts: Alex & Jamie)
  3. `voices.js` — TTS generates audio per line
  4. `stitch.js` — stitched into one MP3
- **Personalization:** localStorage tracks generated topics, derives interest clusters, surfaces relevant suggestions
- **Storage:** Episodes as MP3s in `/episodes/`, metadata in `episodes.json`
- **Real-time:** SSE streams generation progress

## Target User
Anyone. Curious people who want to learn about stuff on their commute, in the gym, or just passing time. No specific age group or subject — the breadth IS the product.

## Revenue Ideas
- Freemium: limited free episodes, paid for unlimited
- Premium voice quality / longer episodes
- Personalised daily digest (one auto-generated episode based on your interests)
- API access

## To Start
```bash
cd /home/pjoscar126/podcastai
node backend/server.js
```
Open `http://localhost:3001`
