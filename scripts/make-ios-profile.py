#!/usr/bin/env python3
"""Builds public/strand.mobileconfig: an iPhone/iPad profile that adds Strand to
the Home Screen as a full-screen app (a "web clip"). Run it again after changing
the icon or the web address. The UUIDs are fixed so a newer profile replaces
the old one instead of adding a second icon."""
import plistlib, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = 'https://kat-heu.github.io/strand/'
icon = (ROOT / 'public/icons/apple-touch-icon.png').read_bytes()

clip = {
    'PayloadType': 'com.apple.webClip.managed',
    'PayloadVersion': 1,
    'PayloadIdentifier': 'app.strand.profile.webclip',
    'PayloadUUID': '6F1C2B7E-3D4A-4E8B-9C21-5A7D8E9F0B13',
    'PayloadDisplayName': 'Strand',
    'Label': 'Strand',
    'URL': URL,
    'Icon': icon,
    'Precomposed': True,
    'FullScreen': True,
    'IsRemovable': True,
    'IgnoreManifestScope': False,
}
profile = {
    'PayloadType': 'Configuration',
    'PayloadVersion': 1,
    'PayloadIdentifier': 'app.strand.profile',
    'PayloadUUID': 'B3E8A1D4-7C2F-4A9E-8B5D-1F6C3E2A9D70',
    'PayloadDisplayName': 'Strand',
    'PayloadOrganization': 'Strand',
    'PayloadDescription': 'Adds Strand to your Home Screen as a full-screen app. It only adds an icon: it does not change any settings and can be removed any time in Settings → General → VPN & Device Management.',
    'PayloadRemovalDisallowed': False,
    'PayloadContent': [clip],
}
out = ROOT / 'public/strand.mobileconfig'
out.write_bytes(plistlib.dumps(profile))
print('wrote', out, out.stat().st_size, 'bytes')
