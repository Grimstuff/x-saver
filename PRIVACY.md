# Privacy Policy

**Last updated: September 2026**

Simple X Download Button (x-saver) is a browser extension that downloads media from X (Twitter). This policy explains what it does and does not do with your data.

## What this extension does not do

- It does not collect personal data for our own use.
- It does not track your browsing activity.
- It does not send data to any third-party analytics or telemetry service.
- It does not upload your media to any server we operate.
- It does not store downloaded files inside the extension; downloads go to your computer via the browser download system.

## What this extension stores

It saves your own settings (GIF conversion on/off, quality preset, filename template) in the browser's extension storage on your device. Those settings are never transmitted to us and are removed when you uninstall the extension.

## What this extension does

When you download media from a tweet, the extension:

1. Reads media URLs from X itself (public syndication when available, or X's authenticated web GraphQL using your existing X session cookies when syndication omits sensitive media).
2. Optionally intercepts X's own in-page GraphQL responses in the page context so media URLs already loaded for you can be reused.
3. For GIFs: decodes and re-encodes video locally in your browser (offscreen document + embedded encoder). That work stays on your device.
4. Saves the file through Chrome's download API.

Network requests go only to X/Twitter hosts needed for the page and media (for example `x.com`, `twitter.com`, `cdn.syndication.twimg.com`, `video.twimg.com`, `pbs.twimg.com`). The `cookies` permission is used only to read your X CSRF cookie (`ct0`) so the extension can call the same GraphQL endpoints the X website uses while you are logged in. Cookie values are not sent to any third party.

## Contact

Questions: open an issue at https://github.com/Grimstuff/x-saver/issues
