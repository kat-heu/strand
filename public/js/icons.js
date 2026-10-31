const s = (d, size = 20) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const f = (d, size = 20) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">${d}</svg>`;

export const I = {
  play: f('<path d="M8 5.4v13.2a1 1 0 0 0 1.52.85l10.6-6.6a1 1 0 0 0 0-1.7L9.52 4.55A1 1 0 0 0 8 5.4z"/>'),
  pause: f('<rect x="6" y="5" width="4.2" height="14" rx="1.2"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2"/>'),
  next: f('<path d="M5 5.6v12.8a1 1 0 0 0 1.55.83L15.5 13v5a1 1 0 0 0 2 0V6a1 1 0 0 0-2 0v5L6.55 4.77A1 1 0 0 0 5 5.6z"/>'),
  prev: f('<path d="M19 5.6v12.8a1 1 0 0 1-1.55.83L8.5 13v5a1 1 0 0 1-2 0V6a1 1 0 0 1 2 0v5l8.95-6.23A1 1 0 0 1 19 5.6z"/>'),
  shuffle: s('<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="m4 4 5 5"/>', 18),
  repeat: s('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>', 18),
  heart: s('<path d="M19.5 13.6 12 21l-7.5-7.4A5 5 0 1 1 12 7a5 5 0 1 1 7.5 6.6z"/>', 18),
  heartFill: f('<path d="M19.5 13.6 12 21l-7.5-7.4A5 5 0 1 1 12 7a5 5 0 1 1 7.5 6.6z"/>', 18),
  user: s('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  headphones: s('<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3z"/><path d="M3 19a2 2 0 0 0 2 2h1v-6H3z"/>'),
  home: s('<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
  search: s('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  library: s('<path d="M4 4v16"/><path d="M9 4v16"/><path d="m14 4.5 5 15"/>'),
  import: s('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
  settings: s('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  lyrics: s('<path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h7"/><circle cx="18" cy="17" r="2.5"/><path d="M20.5 17V10"/>', 18),
  queue: s('<path d="M3 6h13"/><path d="M3 12h13"/><path d="M3 18h9"/><path d="m17 15 4 3-4 3z" fill="currentColor"/>', 18),
  volume: s('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>', 18),
  mute: s('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>', 18),
  more: f('<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>', 18),
  share: s('<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/>', 18),
  chevronDown: s('<path d="m6 9 6 6 6-6"/>', 26),
  chevronLeft: s('<path d="m15 18-6-6 6-6"/>', 26),
  close: s('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  expand: s('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/>', 18),
  trash: s('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>', 18),
  plus: s('<path d="M12 5v14"/><path d="M5 12h14"/>', 18),
  link: s('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>', 18),
  disc: s('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>', 40),
};

// Service marks are simple coloured dots + names (no logos), to stay brand-neutral.
export const SERVICES = {
  spotify: { label: 'Spotify', color: '#1ed760' },
  apple: { label: 'Apple Music', color: '#fa5a6e' },
  youtube: { label: 'YouTube Music', color: '#ff3d3d' },
  soundcloud: { label: 'SoundCloud', color: '#ff7a1a' },
  spotifyRemote: { label: 'Spotify app', color: '#1ed760' },
  preview: { label: 'Preview (30s)', color: '#9aa0b4' },
  local: { label: 'On this device', color: '#3ddc97' },
  itunes: { label: 'iTunes', color: '#fb5c74' },
  catalog: { label: 'Catalog', color: '#9aa0b4' },
};
