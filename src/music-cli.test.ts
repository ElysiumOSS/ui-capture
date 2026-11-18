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

import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildMusicInvocation, MUSIC_USAGE } from "./music-cli.js";
import { buildInvocation, parseCliArgs } from "./runner.js";

describe("music CLI", () => {
	it("parses search limits and paths without changing ordinary URL captures", () => {
		expect(
			buildMusicInvocation([
				"search",
				"ambient & piano",
				"--limit",
				"20",
				"--output-dir",
				"./music/search",
			]),
		).toMatchObject({
			command: "search",
			input: "ambient & piano",
			outputDir: path.resolve("music/search"),
			limit: 20,
		});
		expect(buildInvocation(parseCliArgs(["https://example.com"])).url).toBe(
			"https://example.com",
		);
	});
	it("parses explicit import provenance", () =>
		expect(
			buildMusicInvocation([
				"import",
				"song.mp3",
				"--title",
				"Title",
				"--artist",
				"Artist",
				"--source",
				"https://example.com",
				"--license",
				"mixkit-free",
				"--license-url",
				"https://mixkit.co/license/#musicFree",
				"--output-dir",
				"track",
			]),
		).toMatchObject({
			command: "import",
			title: "Title",
			creator: "Artist",
			license: "mixkit-free",
		}));
	it("parses mix gain, fades and opt-in looping", () =>
		expect(
			buildMusicInvocation([
				"mix",
				"tour.mp4",
				"--track",
				"track.json",
				"--output",
				"with-music.mp4",
				"--volume",
				"0.25",
				"--fade-in",
				"0",
				"--fade-out",
				"1.5",
				"--loop",
			]),
		).toMatchObject({
			command: "mix",
			settings: { volume: 0.25, fadeIn: 0, fadeOut: 1.5, loop: true },
		}));
	it.each([
		["search", "x", "--limit", "30"],
		["fetch", "bad-id"],
		["import", "a.mp3"],
		["mix", "a.mp4", "--track", "a.json"],
		["search", "x", "--unknown"],
		["search", "x", "--loop"],
		[
			"mix",
			"a.mp4",
			"--track",
			"a.json",
			"--output",
			"b.mp4",
			"--volume",
			"NaN",
		],
	])("rejects invalid invocation %j", (argv) =>
		expect(() => buildMusicInvocation(argv)).toThrow());
	it("documents all commands and license requirements", () => {
		for (const command of [
			"search",
			"fetch",
			"import",
			"mix",
			"--license-url",
			"--loop",
		])
			expect(MUSIC_USAGE).toContain(command);
	});
	it("passes soundtrack only in showcase mode", () => {
		expect(
			buildInvocation(
				parseCliArgs([
					"https://example.com",
					"--showcase",
					"tour.json",
					"--soundtrack",
					"track.json",
				]),
			),
		).toMatchObject({ soundtrackPath: path.resolve("track.json") });
		expect(() =>
			buildInvocation(
				parseCliArgs(["https://example.com", "--soundtrack", "track.json"]),
			),
		).toThrow(/showcase/);
		expect(() =>
			buildInvocation(
				parseCliArgs([
					"https://example.com",
					"--showcase",
					"tour.json",
					"--soundtrack",
				]),
			),
		).toThrow(/path/);
	});
});
