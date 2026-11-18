/**
 *
 * Copyright 2026 Mike Odnis
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import { describe, expect, it } from "vitest";
import {
	musicSearchUrl,
	parseOpenverseTrack,
	renderMusicPreview,
} from "./music-provider.js";

const trackFixture = {
	id: "297e676f-18e5-478c-9a39-e707f56eb5be",
	title: '<img src=x onerror="bad()">',
	creator: "Artist & co",
	foreign_landing_url: "https://example.com/source",
	url: "https://example.com/song.mp3",
	license: "by",
	license_version: "3.0",
	license_url: "https://creativecommons.org/licenses/by/3.0/",
	category: "music",
	attribution: "Title by Artist",
	duration: 235000,
};
describe("Openverse music", () => {
	it("encodes one bounded search using only commercial adaptation licenses", () => {
		const url = musicSearchUrl("ambient & piano");
		expect(url.searchParams.get("q")).toBe("ambient & piano");
		expect(url.searchParams.get("category")).toBe("music");
		expect(url.searchParams.get("license")).toBe("cc0,pdm,by");
		expect(url.searchParams.get("page_size")).toBe("10");
		expect(url.searchParams.has("page")).toBe(false);
		for (const limit of [0, 21, 1.2, NaN])
			expect(() => musicSearchUrl("x", limit)).toThrow();
		expect(() => musicSearchUrl(" ")).toThrow();
	});
	it("requires licensed music, source and creator metadata", () => {
		expect(parseOpenverseTrack(trackFixture)).toMatchObject({
			id: trackFixture.id,
			license: "by",
			creator: "Artist & co",
		});
		for (const override of [
			{ license: "by-nc" },
			{ license: "by-sa" },
			{ category: "podcast" },
			{ creator: null },
			{ url: "file:///etc/passwd" },
			{ license_url: "https://evil.example/" },
			{ id: "../oops" },
		]) {
			expect(() =>
				parseOpenverseTrack({ ...trackFixture, ...override }),
			).toThrow();
		}
	});
	it("derives attribution when the provider omits its optional text", () => {
		expect(
			parseOpenverseTrack({ ...trackFixture, attribution: null }).attribution,
		).toContain("Artist & co");
	});
	it("identifies manual previews as imported audio", () => {
		const track = {
			...parseOpenverseTrack(trackFixture),
			provider: "manual" as const,
			license: "mixkit-free",
		};
		const html = renderMusicPreview([track], "audio.mp3");
		expect(html).toContain("Imported music preview");
		expect(html).not.toContain("Openverse");
		expect(html).toContain("Mixkit Free");
	});
	it("renders escaped click-to-play previews, license/source and Openverse notice", () => {
		const html = renderMusicPreview([parseOpenverseTrack(trackFixture)]);
		expect(html).toContain("&lt;img");
		expect(html).not.toContain("<img src=x");
		expect(html).toContain('preload="none"');
		expect(html).toContain("ui-capture music fetch");
		expect(html).toContain("<details><summary>Credits and download</summary>");
		expect(html).toContain("CC BY 3.0");
		expect(html).toContain(trackFixture.foreign_landing_url);
		expect(html).toContain("not endorsed or certified by Openverse");
	});
});
