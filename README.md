# Strand

[![Tests](https://github.com/kat-heu/strand/actions/workflows/ci.yml/badge.svg)](https://github.com/kat-heu/strand/actions/workflows/ci.yml)

One music player for **Spotify, Apple Music, YouTube Music and SoundCloud**. It runs in the browser and also as a desktop app (Windows, macOS, Linux).

- Search across a music catalogue that needs no setup (Apple's free iTunes Search API), with artist and album pages
- One queue and player bar. Each song plays from your preferred service, and if that service doesn't have it, Strand tries the next one automatically (Spotify → Apple Music → YouTube → 30-second preview)
- A "% match" label on every song that was found by searching another service
- Lyrics timed to the music, with a progress fill on the current line and a timing adjuster (from LRCLIB, a free lyrics database)
- A full-screen view with large lyrics and a visualizer (press **L**)
- **Your music:** each listener links their own accounts and sees their music from all of them in one place
  - **Spotify:** playlists, Liked Songs, saved albums, top tracks, recently played, followed artists
  - **Apple Music:** library playlists, songs and albums, recently played, heavy rotation
  - **YouTube Music:** "Sign in with Google" shows their playlists and liked music
  - **SoundCloud:** they link their public profile and see their uploads and likes

  Any list plays straight away, and **Save to library** keeps a copy in Strand.
- **Import** a playlist, album or song from a pasted link on any of the four services
- **Your own music files:** Library → Add your music files (MP3, M4A, FLAC, WAV…). Title, artist, album and cover come from the file's tags; the files stay on that device
- **iTunes sync:** the desktop app reads the library iTunes keeps (or a file exported from the Music app: File → Library → Export Library…) and plays songs straight from their files; on phones and the web, pick the exported file and songs play from a streaming service
- Liked songs, your own playlists, recently played, and library export
- Share links that open a song in Strand, or in any of the four services
- Keyboard shortcuts and system media keys

## Download

| | |
|---|---|
| **Windows** | [**Strand-Setup.exe**](https://github.com/kat-heu/strand/releases/latest/download/Strand-Setup.exe) — installs, then updates itself |
| **Android** | [**Strand.apk**](https://github.com/kat-heu/strand/releases/latest/download/Strand.apk) |
| **iPhone / web** | Open **https://kat-heu.github.io/strand/** (in Safari: Settings → Install on iPhone) |
| macOS, older versions | [All releases](https://github.com/kat-heu/strand/releases) |

Windows shows "Windows protected your PC" on first launch because the installer isn't code-signed yet: click **More info** → **Run anyway**.

No pure-JavaScript dependencies. The web app is plain ES modules, with no build step.

---

## Run it

```bash
npm start            # web app → open http://127.0.0.1:5173/
npm install          # first time only, for the desktop app
npm run desktop      # desktop window
npm run dist         # build installers (.exe / .dmg / .AppImage) into dist/
```

Open **127.0.0.1**, not `localhost`. Spotify only accepts loopback login addresses written as an IP. The app redirects you automatically if you use `localhost`.

### Set up account linking (do this once, as the app owner)

Put your developer keys in **`public/config.js`**. After that, listeners just open **Your music** and press **Connect**, and they never see a key. None of these values is a secret, so they're safe to ship. Never put a client secret or your Apple `.p8` private key in that file.

With no keys at all, everything works except that songs play as 30-second previews and account linking is off. Here is what each key needs (the same steps are in **Settings → Developer keys**):

| Service | What you need | What listeners need |
|---|---|---|
| Spotify | An app at developer.spotify.com (since Feb 2026 the app owner's own account must be **Premium**). Tick *Web API* and *Web Playback SDK*, and add the redirect URI `http://127.0.0.1:5173/` | Spotify **Premium** |
| YouTube Music | In Google Cloud: enable YouTube Data API v3, set up the OAuth consent screen with the scope `youtube.readonly`, and create a **Web** OAuth Client ID with `http://127.0.0.1:5173` as an Authorized JavaScript origin. Optionally, add an API key so people who haven't signed in can still play songs. | A Google account |
| Apple Music | An Apple Developer account ($99/yr), a MusicKit key, and a token made with `node tools/apple-token.js AuthKey.p8 KEY_ID TEAM_ID` | An Apple Music subscription |
| SoundCloud | Nothing | A public profile (they link it by pasting their profile URL) |

Settings shows these steps too, with a copy button for the redirect URI.

### Things to know
- **Google sign-in lasts an hour:** web apps without a server can't get long-lived Google logins. After an hour, a **Reconnect** button appears, and it's one click because the person is still signed in to Google. While your Google app is in *Testing*, only test users you add can sign in. Publishing the app for everyone requires Google's verification.
- **YouTube Music libraries:** YouTube's API covers YouTube playlists and liked videos. YouTube Music playlists and likes show up through these, but YouTube Music-only data such as album shelves and uploads isn't available.
- **SoundCloud** has closed its login API to new apps, so linking reads a public profile instead of signing in. SoundCloud doesn't document whether its player can load a profile's likes page, so the Likes shelf is best-effort. If it fails, Strand says so, and listeners can paste their playlist links into Import instead.
- **Spotify development mode (rules from February 2026):** until Spotify approves your app for extended quota, at most **5** listeners, whom you add under *User Management*, can log in, and your own account must stay Premium or the app stops working. Spotify also only lets apps read the songs in playlists the listener created or collaborates on. Followed playlists, including Spotify's own, show in the list but open with an "Open in Spotify" button. Strand uses the new `/playlists/{id}/items` endpoint.
- **YouTube quota:** every song looked up on YouTube costs 100 of the 10,000 free daily units, so about 100 new songs a day. Results are cached. Songs from imported YouTube playlists already have their video IDs, so playing them costs nothing.
- **YouTube's player stays visible** in the side panel, as YouTube's terms require, and YouTube's own ads can play.
- **SoundCloud** has no in-app search, because its search API needs an approved app.
- **Visualizer:** it reacts to the actual audio only for previews. Spotify, Apple Music, YouTube and SoundCloud don't let apps read their audio, so for those it shows a simulated animation that follows play and pause.
- **The iTunes catalogue** is rate-limited to about 20 requests per minute. Responses are cached in memory.

## Desktop app and DRM

Spotify and Apple Music play through Widevine copy protection. The standard Electron build doesn't include Widevine. For full Spotify and Apple Music playback on desktop, swap in castLabs' Widevine-enabled Electron:

```bash
npm i -D "electron@https://github.com/castlabs/electron-releases#<tag>+wvcus"
```

Pick a current tag from https://github.com/castlabs/electron-releases/releases. Shipped macOS and Windows builds also need castLabs' free VMP signing. `electron/main.js` waits for Widevine automatically when it's present. Without it, the desktop app still plays YouTube, SoundCloud and previews.

## GitHub

- **Tests:** every push to `main` runs the full feature test suite (`tests/e2e.js`, 59 checks with all outside services mocked). Run it locally with `npm install && npx playwright install chromium && npm test`.
- **Automatic updates:** the installed desktop app checks GitHub for a newer release on launch and every 4 hours, downloads it in the background and offers to restart (or installs when you close it). This needs the repository to be public. It works on Windows and Linux; macOS auto-update needs a signed app.
- **Desktop installers:** push a version tag (`git tag v0.1.0 && git push --tags`) and GitHub Actions builds Windows (.exe), macOS (.dmg) and Linux (.AppImage) installers, then attaches them to a draft Release for you to publish. The builds are unsigned, so Windows and macOS show a warning the first time someone opens them. Add code-signing certificates later to remove it.
- **Web version on GitHub Pages:** go to *Settings → Pages* and set Source to **GitHub Actions**, then run **Publish web version** from the Actions tab. The site appears at `https://kat-heu.github.io/strand/`. Add that address as a Spotify redirect URI (with the trailing slash) and as a Google Authorized JavaScript origin (`https://kat-heu.github.io`). Pages is free for public repositories; private ones need a paid GitHub plan.

## Deploy the web version

`public/` is a static site, so you can host it on Netlify, Cloudflare Pages, Vercel or GitHub Pages. Then:
1. In the Spotify dashboard, add `https://your-domain/` as a redirect URI. In Google Cloud, add `https://your-domain` as an Authorized JavaScript origin.
2. Add your domain to the YouTube key's allowed referrers. If you used the optional `origin` argument when making the Apple token, add the domain there too.
3. Put the domain in **Settings → Public URL for share links**, so links you share open the hosted version.

## Phones

The web version is published to **https://kat-heu.github.io/strand/** on every push to `main` (workflow `pages.yml`; one-time setup: Settings → Pages → Source: GitHub Actions).

- **iPhone:** open it in Safari → Settings → **Install on iPhone** → Download profile, then install it from the Settings app (Profile Downloaded). The profile (`public/strand.mobileconfig`, made by `scripts/make-ios-profile.py`) only adds a full-screen Home Screen icon. Share → Add to Home Screen works too.
- **Android:** install `Strand-<version>.apk` from the latest release. It's a Trusted Web Activity (`android/`) that opens the site full-screen in Chrome, so it updates whenever the site does.
  - To sign every build with the same key, add the repository secrets `ANDROID_KEYSTORE_B64` and `ANDROID_KEYSTORE_PASSWORD` (key alias `strand`).
  - To hide Chrome's address bar, publish the `assetlinks.json` shown in the Android workflow's summary at `https://kat-heu.github.io/.well-known/assetlinks.json` (a repo named `kat-heu.github.io` with GitHub Pages on).
- Phones can't run Spotify's in-browser player, so Spotify songs play through YouTube inside Strand by default. "Play in Spotify app" (or Settings → On phones, Spotify songs play…) hands playback to the Spotify app instead, with Strand as the remote.

## How it's organised

```
server.js                 static server on 127.0.0.1:5173 (used by both web and desktop)
electron/main.js          desktop window
tools/apple-token.js      makes the MusicKit developer token
public/config.js          app-owner keys (fill in once)
public/js/
  app.js                  routing, pages, player bar, side panel, full-screen view
  player.js               queue and choosing a source, with fallback
  catalog.js              iTunes Search API (search, artists, albums, charts, matching)
  lyrics.js               LRCLIB lookup and parsing of timed lyrics (including word timing)
  accounts.js             account linking and what each service shows on Your music
  importer.js             reads links and imports from all four services
  visualizer.js           canvas visualizer
  providers/              spotify.js · apple.js · youtube.js · google.js · soundcloud.js · preview.js
```

Every provider has the same interface (`canPlay / load / play / pause / seek / position / duration / stop`), so adding another service is one new file plus one line in `player.js`.
