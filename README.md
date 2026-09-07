# Simple X Download Button

Chromium MV3 extension: download videos, images, and GIFs from X (Twitter). Twitter “GIFs” are MP4s; this extension can convert them to real `.gif` files in-browser.

## Features

- Download button on tweets with own media (not on text-only quote cards)
- Images, videos, and animated GIFs
- Optional in-browser GIF encode (offscreen + gifenc)
- Filename template, quality presets
- NSFW / sensitive posts: falls back to authenticated X GraphQL when public syndication tombstones
- Right-click “Save as GIF” on GIF players

## Install (unpacked)

1. Clone or download https://github.com/Grimstuff/x-saver
2. `chrome://extensions` → Developer mode → **Load unpacked** → folder with `manifest.json`
3. Open x.com and reload the tab after updates

## Settings

Extension icon → Options (or right-click icon → Options):

- GIF conversion on/off
- Quality: Low (360p · 10 fps), Medium (480p · 24 fps), High (720p · 30 fps)
- Filename template: `{username}`, `{tweetid}`, `{date}`, `{type}`, `{index}`

## Permissions (summary)

| Permission | Why |
|---|---|
| `downloads` | Save files |
| `offscreen` | GIF encode |
| `storage` | Settings |
| `contextMenus` | Right-click Save as GIF |
| `cookies` | Read `ct0` for logged-in GraphQL when syndication has no media |
| Host access to X + twimg CDNs | Page scripts, syndication, media bytes |

## Privacy

See [PRIVACY.md](./PRIVACY.md).

## Stack

Plain JS, MV3, no build step. GIF encode via [gifenc](https://github.com/mattdesl/gifenc).
