# Music Library Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development for implementation and separate specification/code-quality reviews.

Goal: Search, preview, fetch/import, and apply licensed music through ui-capture, with accurate docs and license records.
Architecture: An Openverse adapter and bounded media downloader produce a local manifest consumed by a shared audio mixer; the CLI and showcase exporter call those units.
Tech stack: TypeScript, Node fetch/streams/crypto, existing @effect/schema where useful, FFmpeg/ffprobe, Vitest, existing Playwright integration fixtures.

This repository ignores /docs for generated TypeDoc output, so authored design and plan files live under .github.

## Chunk 1: Catalog and local assets

Suggested files: src/music.ts (public orchestration/types), src/music-provider.ts, src/music-assets.ts, src/music-preview.ts and corresponding tests.
Keep responsibilities small; final filenames may follow the implementer's simpler equivalent layout.

- [ ] Review the design and official Openverse audio schema; use source v1 API rather than guessing parameters.
- [ ] Add failing tests for query encoding, music-category/allowed-license filters, missing/bad API metadata, untrusted HTML, and pagination limits.
- [ ] Implement one-page anonymous search with a bounded result count (default 10, maximum 20), clear 429/provider errors, and no automatic bulk traversal.
- [ ] Search writes results.json and a useful index.html with native audio controls (preload none), visible attribution/license/source links, and copyable fetch commands.
- [ ] Add failing tests for selected-track fetch, redirects, HTML/non-audio responses, oversized/stalled downloads, unsafe URLs, cleanup and output collisions.
- [ ] Fetch a fresh track record by UUID, validate allowed license/category, and stream one selected file to a temporary path; probe it with bounded ffprobe and publish the completed asset atomically.
- [ ] Save track.json with relative local audio path, file hash, provider ID, title, creator, source URL, license identifier/version/URL and retrieval time; save credits.txt and a local playable index.html.
- [ ] Add manual local-file import with explicit source/license metadata, supporting authorized Mixkit downloads without building a Mixkit scraper.
- [ ] Keep tests offline using injected HTTP/fetch dependencies or local test fixtures. Live provider verification is a separate manual smoke test.

## Chunk 2: Soundtrack mixing and CLI

Suggested files: src/music-mix.ts, src/music-cli.ts, plus runner.ts, index.ts, showcase.ts and showcase-export.ts only where required.

- [ ] Add tests for CLI parsing/help and backward compatibility. Proposed commands: music search <query>, music fetch <id>, music import <file>, music mix <video> --track <track.json> --output <file>.
- [ ] Expose suitable library functions through index.ts. CLI subcommand parsing must not change ordinary URL capture behavior.
- [ ] Validate track manifests/local paths and actual media, gain/fade parameters, source/output collisions and cancellation before mixing.
- [ ] Use FFmpeg to mux AAC music into an existing MP4 with video stream copy, modest configurable volume (suggested default 0.18), fade-in/out and duration-preserving silence when music is short; looping is explicit, never automatic.
- [ ] Preserve the original video. Publish completed output atomically and include music provenance/credits beside it. Failed or cancelled output must never appear complete.
- [ ] Add --soundtrack <track.json> for showcase capture (and a library equivalent) so a fresh tour can use the same asset; reject soundtrack-only options in incompatible capture modes.
- [ ] Integration tests use generated tones: verify video duration/dimensions/frame rate survive, audio stream exists and has nonzero levels, fades work, and silent behavior remains unchanged.
- [ ] Check failure and cancellation cleanup with real FFmpeg where meaningful; do not redesign the proven browser recorder.

## Chunk 3: Docs, review, validation and release

- [ ] Update README with discovery → browser preview → selected fetch/import → existing-video mix → showcase soundtrack examples.
- [ ] Add an npm-shipped music guide if README becomes unwieldy; document Mixkit, Openverse, Epidemic Sound, rights/attribution and personal-versus-commercial scope with primary links.
- [ ] Explain source verification, attribution publication, retention of license evidence, and platform-specific limits without promising automatic legal clearance.
- [ ] Document the known fullscreen recording setting --launch-args "--window-size=1920,1080" in the applicable showcase example; no unrelated browser rewrite.
- [ ] Obtain specification and independent quality reviews, resolve findings, run all CI-equivalent checks and the full real browser/FFmpeg integration suite, then commit the verified implementation.
- [ ] Parent independently uses the built CLI to search/fetch a real allowed track, checks source license, previews it, and creates a music version of the completed portfolio tour.
- [ ] Parent opens the PR, follows the repository checklist/linked-issue workflow, polls exact-head CI, merges under existing authorization, verifies automatic npm publication and installed CLI behavior, and delivers exact commands and artifacts.
