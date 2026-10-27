// App-owner configuration. Fill these in once and every listener only sees
// "Connect" buttons — they never have to deal with developer keys.
// (Values entered in Settings → Developer keys override these on that device.)
//
// These are all *public* identifiers that are safe to ship in a web app:
// none of them is a secret. Never put a client secret or a .p8 private key here.
export default {
  // Spotify app Client ID — developer.spotify.com/dashboard
  spotifyClientId: 'e393800bbf5b429e995e4846e9c39529',

  // Google OAuth 2.0 Client ID (type "Web application") — console.cloud.google.com
  // Lets listeners sign in with Google to see their YouTube / YouTube Music playlists & likes.
  googleClientId: '',

  // Optional YouTube Data API key — lets people who haven't signed in with Google
  // still play songs via YouTube. Restrict it to your domain in Google Cloud.
  youtubeKey: '',

  // Apple MusicKit developer token (JWT) — generate with tools/apple-token.js
  appleDevToken: '',
};
