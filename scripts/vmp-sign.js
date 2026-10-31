// Production "Verified Media Path" (VMP) signing for Widevine, through castLabs' free
// EVS service. The castLabs Electron build ships with a development signature;
// Spotify's (and Apple's) license servers can require the production one.
//
// Runs from electron-builder's afterPack hook on Windows and macOS (Linux has no VMP).
// Needs `python -m castlabs_evs` logged in (CI does this when the EVS_ACCOUNT_NAME /
// EVS_PASSWD secrets exist). Without it the build still works, keeping the
// development signature, and prints a warning.
const { execFileSync } = require('child_process');

const PY = process.env.EVS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  if (platform !== 'win32' && platform !== 'darwin') return;
  const skip = why => console.warn(`[VMP] ${why} — keeping the development signature (Spotify may refuse in-app playback).`);
  try { execFileSync(PY, ['-m', 'castlabs_evs.vmp', '--help'], { stdio: 'ignore' }); }
  catch { return skip('castlabs-evs isn’t installed'); }
  if (!process.env.EVS_LOGGED_IN) return skip('no EVS account (add the EVS_ACCOUNT_NAME and EVS_PASSWD secrets)');
  try {
    console.log(`[VMP] signing ${context.appOutDir}`);
    execFileSync(PY, ['-m', 'castlabs_evs.vmp', '-n', 'sign-pkg', '--streaming', context.appOutDir], { stdio: 'inherit' });
    execFileSync(PY, ['-m', 'castlabs_evs.vmp', '-n', 'verify-pkg', context.appOutDir], { stdio: 'inherit' });
  } catch (e) { skip('signing failed: ' + e.message); }
};
