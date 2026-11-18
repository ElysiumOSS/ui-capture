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
import { fetchMusic, importMusic, searchMusic } from "./music.js";
import {
	type MusicMixSettings,
	mixMusic,
	validateMusicMixSettings,
} from "./music-mix.js";
import { musicId } from "./music-provider.js";
import { parseArgs } from "./utils/args.js";
export const MUSIC_USAGE = `Usage: ui-capture music <command> [options]

  search <query>       Search one page of Openverse music; write results.json and index.html
  fetch <uuid>         Download one selected Openverse track with track.json and credits
  import <file-or-url> Import one authorized local file or direct HTTP(S) audio URL
  mix <video>          Add a local track to an existing video, replacing existing audio

Search: --limit <1-20> (default 10), --output-dir <new-directory> (default ./music-search)
Fetch:  --output-dir <new-directory> (default ./music/<uuid>)
Import: --output-dir <new-directory> --title <title> --artist <artist>
        --source <original-page-url> --license <identifier> --license-url <url>
        Optional: --license-version <version> --attribution <text>
Mix:    --track <track.json> --output <new.mp4>
        --volume <0-1> (default 0.18) --fade-in <seconds> (default 1)
        --fade-out <seconds> (default 2) --loop (explicitly repeat short music)
Media:  --ffmpeg <binary> (mix only), --ffprobe <binary> (fetch/import/mix)
        --help

Outputs are never overwritten. Silent showcase capture remains the default.
Verify source licenses and publish required credits. See MUSIC.md for the workflow.
`;
interface BaseInvocation {
	input: string;
	ffprobePath?: string;
}
type MusicInvocation =
	| (BaseInvocation & { command: "search"; outputDir: string; limit: number })
	| (BaseInvocation & { command: "fetch"; outputDir: string })
	| (BaseInvocation & {
			command: "import";
			outputDir: string;
			title: string;
			creator: string;
			sourceUrl: string;
			license: string;
			licenseUrl: string;
			licenseVersion?: string;
			attribution?: string;
	  })
	| (BaseInvocation & {
			command: "mix";
			trackPath: string;
			outputPath: string;
			settings: MusicMixSettings;
			ffmpegPath?: string;
	  });
export const buildMusicInvocation = (
	argv: readonly string[],
): MusicInvocation => {
	const parsed = parseArgs([...argv], ["help", "loop"]);
	const [command, input] = parsed.positional;
	if (
		!input ||
		parsed.positional.length !== 2 ||
		!["search", "fetch", "import", "mix"].includes(command)
	)
		throw new Error(
			"Music requires search, fetch, import or mix and one quoted query/file/ID argument",
		);
	const opts = parsed.options;
	const allowed: Record<string, string[]> = {
		search: ["limit", "output-dir"],
		fetch: ["output-dir", "ffprobe"],
		import: [
			"output-dir",
			"ffprobe",
			"title",
			"artist",
			"source",
			"license",
			"license-url",
			"license-version",
			"attribution",
		],
		mix: [
			"track",
			"output",
			"volume",
			"fade-in",
			"fade-out",
			"loop",
			"ffmpeg",
			"ffprobe",
		],
	};
	for (const key of Object.keys(opts))
		if (!allowed[command].includes(key) && key !== "help")
			throw new Error(`Unknown option for music ${command}: --${key}`);
	const value = (key: string, fallback?: string): string => {
		const raw = opts[key] ?? fallback;
		if (typeof raw !== "string" || !raw.trim())
			throw new Error(`--${key} requires a value`);
		return raw;
	};
	const optional = (key: string): string | undefined =>
		opts[key] === undefined ? undefined : value(key);
	const numeric = (key: string, fallback: number): number => {
		const number = Number(value(key, String(fallback)));
		if (!Number.isFinite(number))
			throw new Error(`--${key} requires a finite number`);
		return number;
	};
	const base = {
		input,
		...(optional("ffprobe") ? { ffprobePath: optional("ffprobe") } : {}),
	};
	if (command === "search") {
		const limit = numeric("limit", 10);
		if (!Number.isInteger(limit) || limit < 1 || limit > 20)
			throw new Error("--limit must be from 1 to 20");
		return {
			...base,
			command,
			limit,
			outputDir: path.resolve(value("output-dir", "music-search")),
		};
	}
	if (command === "fetch")
		return {
			...base,
			command,
			outputDir: path.resolve(
				value("output-dir", path.join("music", musicId(input))),
			),
		};
	if (command === "import")
		return {
			...base,
			command,
			outputDir: path.resolve(value("output-dir")),
			title: value("title"),
			creator: value("artist"),
			sourceUrl: value("source"),
			license: value("license"),
			licenseUrl: value("license-url"),
			licenseVersion: optional("license-version"),
			attribution: optional("attribution"),
		};
	if (opts.loop !== undefined && opts.loop !== true)
		throw new Error("--loop is a boolean flag");
	return {
		...base,
		command: "mix",
		trackPath: path.resolve(value("track")),
		outputPath: path.resolve(value("output")),
		ffmpegPath: optional("ffmpeg"),
		settings: validateMusicMixSettings({
			volume: numeric("volume", 0.18),
			fadeIn: numeric("fade-in", 1),
			fadeOut: numeric("fade-out", 2),
			loop: opts.loop === true,
		}),
	};
};
export const runMusicFromArgs = async (
	argv: readonly string[],
): Promise<void> => {
	if (!argv.length || argv.includes("--help")) {
		console.log(MUSIC_USAGE);
		return;
	}
	const cancellation = new AbortController();
	const interrupt = () =>
		cancellation.abort(new Error("Music command cancelled"));
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", interrupt);
	try {
		const invocation = buildMusicInvocation(argv);
		const signal = cancellation.signal;
		if (invocation.command === "search") {
			const tracks = await searchMusic(invocation.input, {
				...invocation,
				signal,
			});
			console.log(
				`${tracks.length} music results. Preview: ${path.join(invocation.outputDir, "index.html")}`,
			);
		} else if (invocation.command === "fetch") {
			await fetchMusic(invocation.input, { ...invocation, signal });
			console.log(
				`Music saved: ${path.join(invocation.outputDir, "track.json")}`,
			);
		} else if (invocation.command === "import") {
			await importMusic(invocation.input, { ...invocation, signal });
			console.log(
				`Music imported: ${path.join(invocation.outputDir, "track.json")}`,
			);
		} else {
			await mixMusic(invocation.input, invocation.trackPath, {
				...invocation,
				...invocation.settings,
				signal,
			});
			console.log(
				`Music video saved: ${invocation.outputPath}\nCredits: ${invocation.outputPath}.credits.txt`,
			);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	} finally {
		process.removeListener("SIGINT", interrupt);
		process.removeListener("SIGTERM", interrupt);
	}
};
