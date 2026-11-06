# Speed test

Measures Sentry Six Manager on your own hardware and footage, and writes a
report you can share (Markdown, plus the raw numbers as JSON).

What it measures:

- **Install and start** (with `--docker`): pulling the image (`--cold` removes
  it first, so it is a first-time install), a fresh container until it
  answers, its sign-in page, and your footage indexed (`--footage`).
- **Server answers**: sign-in, the vehicle list, days, a day's recordings,
  server stats, a clip's telemetry, the first megabyte of a clip from your
  footage, and the timeline previews of a clip.
- **Pages**: the first load in a new tab and every page of the menu, on a
  desktop screen and on a phone (iPhone 14 size).
- **Viewer**: opening a day (a picture on every camera, and every video
  ready), seeking, dragging the timeline, the next clip, and how close the
  cameras stay while playing.
- **Export** (with `--export`): one minute of every camera as one video.

It only reads, except `--export` (one export, removed after a day like any
other) and `--all-packs` (switches the interface for everyone while it
measures every interface, then puts yours back).

## Run it

On any computer that can open your Sentry Six Manager, with Node.js 20 or
newer:

```bash
cd tools/benchmark
npm install
npx playwright install chromium
node benchmark.mjs --url https://192.168.1.57:9000 --user admin --password "your password"
```

Add `--all-packs` to measure every interface, `--export` for the export, and
`--docker --cold` (on a computer with Docker) for install and start;
`--footage <folder that holds TeslaCam>` lets the start test index real
footage. `--vehicle <id>` and `--day YYYY-MM-DD` pick what the Viewer opens
(by default the vehicle with the most footage and a day with every camera).

The browser runs on the computer you run it on, so the page and Viewer
numbers include your network to the server, as they would for anyone using
it from that computer.
