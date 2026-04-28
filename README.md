# ui-capture

<p align="center">
  <b>Effect-based crawler that walks a website and captures full-page screenshots (PNG/WebP/JPEG) and optional multi-quality videos for every reachable internal route.</b>
</p>

<p align="center">
  <a href="https://github.com/ElysiumOSS/ui-capture/blob/main/LICENSE.md" target="_blank"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-21bb42.svg" /></a>
  <a href="https://npmjs.com/package/@elysiumoss/ui-capture" target="_blank"><img alt="npm version" src="https://img.shields.io/npm/v/@elysiumoss/ui-capture?color=21bb42&label=npm" /></a>
</p>

## Overview

`ui-capture` drives a headless Chromium via Playwright to crawl a site, follow internal links up to a configurable depth, and snapshot every reachable route across multiple viewports.
It is built on Effect for structured concurrency, retries, and predictable cleanup.

For each route it produces:

- **PNG** — lossless, taken once into a buffer.
- **WebP** — real WebP, encoded by piping the PNG buffer through `ffmpeg`/`libwebp`.
- **JPEG** — Playwright's native JPEG.
- **Video** (optional) — `recordVideo` master at 1× plus 0.75× / 0.5× transcodes via `ffmpeg`/`libvpx-vp9`.

It also writes a `capture-report.json` and `REPORT.md` to the output directory.

## Requirements

- [Bun](https://bun.sh/) ≥ 1.x or Node ≥ 20.19
- Chromium (auto-installed by Playwright)
- `ffmpeg` on `PATH` (or pass `--ffmpeg`)

## Installation

```bash
bun add -g @elysiumoss/ui-capture
# or
npm i -g @elysiumoss/ui-capture
```

Then install Playwright's Chromium browser once:

```bash
bunx playwright install chromium
```

## CLI

```text
Usage: ui-capture <url> [options]

Arguments:
  <url>                       Starting URL to crawl

Options:
  --output-dir <path>         Output directory (default: ./ui-captures)
  --max-depth <n>             Maximum crawl depth (default: 2)
  --wait <ms>                 Per-page wait after networkidle (default: 2000)
  --concurrency <n>           Parallel route workers (default: 2)
  --include-subdomains        Crawl subdomains of the starting host
  --allowed-hosts <a,b,...>   Extra allowed hostnames (comma separated)
  --viewports <spec,spec>     Viewport specs as name:WIDTHxHEIGHT
                              (default: desktop:1920x1080,tablet:768x1024,mobile:375x667)
  --hide <sel,sel,...>        CSS selectors to hide before screenshotting
  --menu-selectors <sel,...>  Selectors to click before link discovery
  --video                     Capture videos in addition to screenshots
  --video-duration <ms>       Video duration when --video (default: 10000)
  --no-interactions           Disable scripted scrolling during video
  --no-warmup                 Skip the pre-screenshot warm-up scroll
  --ffmpeg <path>             ffmpeg binary path (default: ffmpeg)
  --help                      Show this message

Examples:
  ui-capture https://example.com
  ui-capture https://example.com --video --max-depth 1 --concurrency 4
  ui-capture https://example.com --viewports desktop:1920x1080,mobile:390x844
```

## Library

```ts
import { Effect } from "effect";
import {
  CaptureConfigLive,
  UICaptureService,
} from "@elysiumoss/ui-capture";

const program = Effect.gen(function* () {
  const service = yield* UICaptureService;
  return yield* service.captureWebsite("https://example.com");
}).pipe(
  Effect.provide(UICaptureService.Default),
  Effect.provide(
    CaptureConfigLive({
      outputDir: "./ui-captures",
      maxDepth: 1,
      captureVideo: true,
    }),
  ),
);

await Effect.runPromise(program);
```

## Output layout

```text
ui-captures/
├── REPORT.md
├── capture-report.json
└── <route>/
    ├── screenshots/
    │   ├── png/{<viewport>_WxH_latest.png, history/<viewport>_WxH_<ts>.png}
    │   ├── webp/{...}
    │   └── jpg/{...}
    └── videos/                              # only when --video
        ├── high-quality/<viewport>_WxH_<ts>.webm
        ├── medium-quality/...
        └── low-quality/...
```

## Notes

- **Asset filtering** — link discovery skips URLs whose pathname ends in common asset extensions (`.css`, `.js`, `.png`, `.svg`, `.xml`, `.webmanifest`, fonts, media, archives) so frameworks that expose chunk paths in `__NEXT_DATA__` don't poison the crawl queue.
- **Warm-up scroll** — before each screenshot pass, the page is scrolled top → bottom in steps and back, triggering IntersectionObserver-based lazy-loads and scroll-reveal animations.
  Disable with `--no-warmup`.
- **Parallax** — true scroll-progress-driven parallax (pinned + transformed elements) renders at scroll=0 once warm-up returns to top.
  A stitched-capture mode for that case is on the roadmap.

## License

MIT — see [LICENSE.md](./LICENSE.md).
