# Music for website demos

Search for music, listen in a browser, save one track and add it to an existing video or a new showcase recording.
Install FFmpeg and ffprobe on your PATH for downloads, imports and mixing.
Captures stay silent unless you select a soundtrack.

## Search and preview

```bash
ui-capture music search "ambient electronic" --limit 10 --output-dir ./music/search-1
```

Open `music/search-1/index.html` in your browser and press Play on a track.
Previews load only when requested and can fail if the original host no longer serves the audio.
Each result shows the creator, source, license and audio controls.
Expand “Credits and download” for attribution and a copyable fetch command.
The same metadata is saved in `results.json`.

Search uses the [official Openverse audio API](https://api.openverse.org/v1/), without an account or API key.
It requests one page of music, with a default of 10 results and a maximum of 20.
Only CC0, Public Domain Mark and CC BY records are accepted.
The promotional-video workflow excludes noncommercial, no-derivatives and share-alike licenses.
Invalid or incomplete records are omitted, so a page can contain fewer results than requested.

This tool is made using Openverse; it is not endorsed or certified by Openverse.
Openverse is an index: its metadata does not establish that the uploader owns every necessary right.
Verify the license on the original source page before using a track, as required by the [Openverse terms](https://docs.openverse.org/terms_of_service).

## Fetch a selected track

Copy a UUID from your search results and fetch it into a different, new directory:

```bash
ui-capture music fetch <uuid-from-results> --output-dir ./music/selected
```

The command retrieves fresh metadata and downloads one audio file.
The asset directory contains:

```text
music/selected/
├── audio.mp3          # extension follows the probed audio container
├── track.json         # source, license, retrieval time, duration and SHA-256
├── credits.txt
└── index.html         # local audio preview
```

Open the local `index.html` to listen to the saved file.
Keep the directory together: `track.json` refers to the audio by a relative filename, and the mixer verifies its hash.
Downloads do not retry or traverse additional catalog pages automatically.
If a provider returns HTTP 429, wait before trying again.

## Import a licensed file or direct URL

[Mixkit's free music library](https://mixkit.co/free-stock-music/) is a convenient browsing option for commercial web and social videos.
Its [Stock Music Free License](https://mixkit.co/license/modal/musicFree/) permits those uses, with restrictions including broadcast, games and standalone music redistribution.
Check the selected item's license and [Mixkit's terms](https://mixkit.co/terms/) for your intended use.
Browse and download a track yourself, then retain its title, artist and source page:

```bash
ui-capture music import ./Downloads/selected-song.mp3 \
  --title "Selected song" --artist "Artist name" \
  --source "https://mixkit.co/free-stock-music/ambient/" \
  --license mixkit-free --license-url "https://mixkit.co/license/#musicFree" \
  --output-dir ./music/mixkit-track
```

You can also pass one direct HTTP(S) audio URL in place of the file path, if that provider permits downloading it.
Import does not browse or scrape catalog pages.
It requires explicit source and license information; those fields record your evidence rather than verify your authorization.
Optional `--license-version` and `--attribution` preserve additional details.

## Add music to an existing video

```bash
ui-capture music mix ./portfolio-full-tour.mp4 \
  --track ./music/selected/track.json \
  --output ./portfolio-full-tour-with-music.mp4 \
  --volume 0.18 --fade-in 1 --fade-out 2
```

The original video remains unchanged.
The new MP4 copies its video stream without re-encoding and replaces any existing audio with AAC music.
Volume defaults to `0.18` and accepts values from `0` to `1`.
Fades accept `0` to `30` seconds and are shortened to fit the track when necessary.
Short music fades out at its end, then silence fills the rest of the video.
Add `--loop` to repeat it explicitly until the video ends.
The mix keeps the full video duration.

Two files beside the new video preserve provenance:

- `portfolio-full-tour-with-music.mp4.credits.txt`: credit text and the audio changes made.
- `portfolio-full-tour-with-music.mp4.music.json`: track metadata and mix settings.

Publish required credits in your video description, end credits or another location allowed by the license.
A local sidecar alone does not publish attribution to viewers.
For CC BY, include the title, creator, source and license link and describe changes; see [Creative Commons license guidance](https://creativecommons.org/cc-licenses/).
Keep your original license evidence as well as the generated records.

## Record a new video with the same track

```bash
ui-capture https://example.com \
  --showcase ./tour.json --soundtrack ./music/selected/track.json \
  --output-dir ./demo-with-music --viewports desktop:1920x1080 \
  --launch-args "--window-size=1920,1080"
```

Use the window-size launch argument when the site uses fullscreen mode, so the Chromium window matches the recording viewport.
`--soundtrack` requires `--showcase` and uses the default volume and fades.
For custom mix settings, use the library or export silently and run `music mix`.
A successful recording includes `showcase.mp4.credits.txt` and `showcase.mp4.music.json` beside its usual artifacts.

```typescript
import { captureShowcase, mixMusic } from "@elysiumoss/ui-capture";

await mixMusic("./tour.mp4", "./music/selected/track.json", {
  outputPath: "./tour-with-music.mp4",
  volume: 0.2,
  fadeIn: 1,
  fadeOut: 2,
  loop: false,
});

await captureShowcase("https://example.com", tourDefinition, {
  outputDir: "./new-recording",
  launchArgs: ["--window-size=1920,1080"],
}, {
  soundtrack: "./music/selected/track.json",
  music: { volume: 0.2, fadeOut: 2 },
});
```

The library also exports `searchMusic`, `fetchMusic`, `importMusic` and `loadMusicManifest`.
Long-running operations accept an `AbortSignal`.
CLI cancellation with Ctrl+C removes partial music outputs.
Every asset/search directory and final output must be new; existing files are never overwritten.

## Other libraries and limits

[Epidemic Sound](https://developers.epidemicsound.com/docs/) offers a curated paid catalog and an API.
Its free developer plan supports prototyping and has no commercial license.
Production API use requires a paid API agreement; a regular Pro subscription is a separate product and does not by itself establish API access.
This integration does not require an Epidemic account or key.
You can import a track obtained under a suitable license and retain its evidence.

[Spotify's terms](https://www.spotify.com/us/legal/end-user-agreement/) grant personal listening access, not permission to reuse a song as a promotional soundtrack.
A Premium subscription is not a soundtrack license.

Music requests accept public HTTP(S) destinations without credentials and validate redirects.
JSON responses are limited to 2 MiB and 15 seconds; audio downloads to 100 MiB and 120 seconds.
Local audio is also limited to 100 MiB, and supported media duration is at most one hour.
FFmpeg processes have time and output limits, with restricted input containers and protocols.
Use `--ffprobe` for a custom probe binary and `music mix --ffmpeg` for a custom encoder.

Native browser previews contact the original audio host when you press Play.
Preview HTML is intended for your local workflow, not a hosted redistribution catalog.
The npm package contains no songs.
