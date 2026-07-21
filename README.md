# Onyx

A lightweight dark frontend for discovering and watching YouTube videos.

## What was fixed

The original player sent every video through `/api/stream/:id` using an old `youtubei.js` release. That approach was brittle for browser seeking, cloud-host rate limits, signed media URLs and upstream YouTube changes. A metadata failure also prevented the player from appearing at all.

Onyx now:

- loads a privacy-enhanced YouTube embed immediately
- keeps search, metadata and recommendations on the Onyx backend
- keeps playback available when metadata temporarily fails
- uses a current `youtubei.js` version and the supported `getHomeFeed()` API
- accepts normal searches, video IDs and pasted YouTube URLs
- adds search suggestions, theater mode, copy-link and a YouTube fallback link
- validates video IDs and sends a restrictive Content Security Policy

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

Node.js 20 or newer is recommended.

## Deploy on Render

The included `render.yaml` creates a Node web service. Connect the repository in Render and deploy the Blueprint, or use:

- Build command: `npm install`
- Start command: `npm start`
- Health check: `/api/health`

## Notes

Playback uses YouTube's privacy-enhanced embed domain. Individual creators can disable embedding for a video; the **open on youtube** button remains available for those cases. YouTube may still show its own player UI or advertising.
