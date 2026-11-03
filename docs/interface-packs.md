# Your own interface (UI packs)

[← Back to the README](../README.md)

Settings → Interface sets how Sentry Six Manager looks and works for
everyone who signs in. **Original** is the built-in interface; the drop-down
also lists every interface pack you uploaded. A switch applies at once:
open pages reload by themselves, with no restart.

A pack is a `.zip` whose files take the place of the built-in files with the
same path, so it can change one stylesheet or replace the whole interface:

```
ui.json        {"name": "Ocean", "description": "...", "author": "..."}
web/           the manager: index.html, app.js (the pages), shell.css (the look)
studio/        the Viewer (index.html) and the Encoder (encoder.html)
```

**Download the original to start from** gives the built-in interface as a
pack: change what you like, zip it and upload it. Scripts must be files in
the pack (the pages run no inline scripts and nothing from other sites).

A pack's scripts run as whoever is signed in and can do anything you can,
so only upload packs you made or trust; uploading or choosing one asks for
your password. If a pack breaks the pages, open `https://<server>/original`:
that browser then shows the built-in interface (until you press **Show the
chosen interface**), and Settings → Interface can switch back for everyone.
Packs are kept in `./data/ui-packs`.

Four complete packs, every page rebuilt from scratch, come with the app and
are always in the drop-down (their source and zips are in
[`examples/ui-packs`](../examples/ui-packs)): **Daylight**
(`daylight.zip`), a calm, light-first interface for everyday use, and
**Flux** (`flux.zip`), a dark console with a command palette, live charts
and keyboard shortcuts for the numbers people. **Horizon** (`horizon.zip`) is a
synthwave dashboard over a neon grid that scrolls toward a setting sun. **Aurora**
(`aurora.zip`) floats glass windows over drifting northern lights, with a
cockpit-style Viewer.
