# Showcase recording

## Goal

Record a reusable scripted website tour and deliver an upload-ready MP4, scene stills, a poster, captions and an execution report.
The owner requested this feature and selected a broader portfolio tour as the first example.
That first recording should run about 45–60 seconds in landscape, with brief captions and no soundtrack.

## Design

`ui-capture <url> --showcase tour.json` is an exclusive capture mode, separate from crawling or independent scripted-state captures.
A versioned JSON file names an ordered sequence of scenes.
Each scene can navigate to a URL, wait for a readiness selector, run steps, show a caption and hold its final view.
Scenes without a URL continue on the current page, preserving filters and other interaction state.
Reuse the existing declarative interaction vocabulary and its request permissions; add timed typing, hover and smooth scrolling for recordings.
No arbitrary user-supplied JavaScript belongs in the format.

One browser context and fixed viewport records the whole tour, so screenshots and video come from the same execution.
Capture the interactions themselves; do not replay mutations to generate a second artifact.
Show a subtle cursor/click indicator and optional scene captions inside safe margins.
Trim the initial load from the delivered video and preserve the source recording for inspection.
Export H.264 MP4 with yuv420p, constant 30 fps and fast-start metadata, plus PNG scene stills, a poster, SRT scene captions and JSON/Markdown reports.
The default showcase viewport is desktop 1920x1080; explicit viewport options may request alternatives.

Validate names, paths, duplicate scenes, numeric ranges, URL schemes and origin permissions before launching Chromium.
Preserve existing opt-ins for API request steps and HTTPS exceptions.
Bound scene/step/run durations, identify the actual failing scene and step, and close browser contexts and encoders on all exits.
A failed tour must not be reported as complete or leave a partial file under the final MP4 name.
Existing route/state capture behavior stays compatible.

## Implementation plan

- [x] Establish the baseline and review the existing schema, scripted runner and video lifecycle.
- [x] Add a pure showcase schema/parser with invalid-input and navigation-permission tests.
- [x] Implement the continuous recorder and presentation helpers with tests for typing, state continuity, screenshots, deadlines and cleanup.
- [x] Add MP4/poster/caption export with argument-safety, timing and failure tests.
- [x] Wire the CLI and library exports, document the JSON format and add a reusable example.
- [x] Run a real local-browser/FFmpeg integration test and inspect codec, dimensions, timing and frame content.
- [x] Run project checks, obtain independent specification and code reviews, and fix findings.
- [x] Record and inspect the broader portfolio tour, adjust pacing, and verify its final MP4 against LinkedIn upload limits.
- [ ] Merge through reviewed CI, verify the automatic npm release, and deliver the video and exact replay command.

## First tour

Home introduction, project filtering and a ResQ case study, experience and nested roles, live stats, then consulting/contact.
The actual selectors must be observed on the live pages.
All production interactions in this preset are navigation, search, filtering or viewing existing content.
Posting to LinkedIn is left to the owner.
