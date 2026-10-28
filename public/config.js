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
  googleClientId: '240686563429-1obqmqnfpuk1a22lnfmpn5d1p6lvruj5.apps.googleusercontent.com',

  // Optional YouTube Data API key — lets people who haven't signed in with Google
  // still play songs via YouTube. Restrict it to your domain in Google Cloud.
  youtubeKey: '',

  // Strand accounts (Supabase). Project URL + publishable ("anon") key — both public.
  // Leave empty to run Strand without accounts.
  supabaseUrl: 'https://kfyrmrnkpjmkhhrrvevl.supabase.co',
  supabaseKey: 'sb_publishable_dzAHwTQ4Mzutgv4yuLF2JQ_svTcrtE2',

  // Apple MusicKit developer token (JWT) — generate with tools/apple-token.js
  appleDevToken: '',
};
