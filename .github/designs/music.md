# Music for showcase videos

The owner requested music-library documentation and an integration that can pull songs, following the completed portfolio showcase.
Use the existing CLI and a free, supported API, with browser previews and reusable local files.
The established authorization covers implementation, testing, PR merge and automatic npm publication.

## Approach

Openverse provides anonymous audio search, track metadata, source URLs, and license information.
Use its music category with CC0, public-domain mark, and CC BY results; exclude NC, ND and share-alike material from this promotional-video workflow.
Each command fetches a bounded results page or one selected track, never an entire catalog.
Search results include a local HTML page with click-to-play audio previews, title, creator, license, attribution and original-source links.
A selected download becomes a local asset with a manifest, SHA-256, source/license metadata, attribution text, and a local audio preview page.
Index metadata is evidence to verify at the original source, not a warranty that rights are cleared.

Mixkit remains a documented free browsing option and supports importing a manually downloaded track with its source and license information.
Do not scrape its catalog or bundle third-party songs in the npm package.
Epidemic Sound is documented as a paid alternative; its API requires separate access and production licensing, and the free developer tier is not a commercial soundtrack license.
Spotify playback or Premium does not grant soundtrack rights.

Support both adding a selected local track to a new showcase and mixing it into an existing video without recording again.
Keep the current silent export as the default.
Output AAC audio with gain and fades, preserve the video and its full duration, and include credits/source details beside the export.
Never change the original video or overwrite an existing output.

## Boundaries

- HTTP(S) media only, no URL credentials, unsafe local/private destinations or unchecked redirect destinations.
- Bounded requests, response sizes, download bytes and media-process duration; cancel and clean partial files on error.
- Validate license and actual audio metadata before using a track; do not trust extensions or HTML error responses.
- Escape all API/user metadata in preview HTML; no embedded untrusted markup or script.
- Local preview pages are for personal workflow use, not a hosted music redistribution service.
- No new runtime dependency unless necessary; use the existing Node/FFmpeg stack.
- No portfolio source changes, unrelated dependency upgrades, paid subscriptions, messages, or LinkedIn posting.

## Primary references

- https://api.openverse.org/v1/
- https://docs.openverse.org/api/reference/search_algorithm.html
- https://mixkit.co/free-stock-music/
- https://mixkit.co/license/modal/musicFree/
- https://mixkit.co/terms/
- https://developers.epidemicsound.com/docs/
- https://creativecommons.org/cc-licenses/
- https://www.spotify.com/us/legal/end-user-agreement/

An actual anonymous Openverse request returned 66 matching ambient music results, including CC BY tracks with playable Jamendo asset URLs.
The probe is saved at /tmp/ui-capture-openverse-probe.json.
