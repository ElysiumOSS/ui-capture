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
// cspell:words atrim afade apad nostdin movflags faststart

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadMusicManifest } from "./music.js";
import {
	type MusicProcessOptions,
	musicInputArgs,
	probeMusicMedia,
	runMusicProcess,
} from "./music-process.js";
import { musicCredits } from "./music-provider.js";
export interface MusicMixSettings {
	readonly volume?: number;
	readonly fadeIn?: number;
	readonly fadeOut?: number;
	readonly loop?: boolean;
}
export interface MusicMixOptions extends MusicMixSettings, MusicProcessOptions {
	readonly outputPath: string;
	readonly ffmpegPath?: string;
	readonly ffprobePath?: string;
}
export const validateMusicMixSettings = (
	options: MusicMixSettings,
): Required<MusicMixSettings> => {
	const settings = {
		volume: options.volume ?? 0.18,
		fadeIn: options.fadeIn ?? 1,
		fadeOut: options.fadeOut ?? 2,
		loop: options.loop ?? false,
	};
	if (
		!Number.isFinite(settings.volume) ||
		settings.volume < 0 ||
		settings.volume > 1
	)
		throw new Error("Music volume must be between 0 and 1");
	for (const fade of [settings.fadeIn, settings.fadeOut])
		if (!Number.isFinite(fade) || fade < 0 || fade > 30)
			throw new Error("Music fades must be between 0 and 30 seconds");
	if (typeof settings.loop !== "boolean")
		throw new Error("Music loop must be a boolean");
	return settings;
};
const requireAbsent = async (file: string): Promise<void> => {
	try {
		await fs.lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	throw new Error(`Music output already exists: ${file}`);
};
/** Replace source audio with a local soundtrack, copying video packets unchanged. */
export const mixMusic = async (
	video: string,
	manifestPath: string,
	options: MusicMixOptions,
): Promise<void> => {
	const settings = validateMusicMixSettings(options);
	options.signal?.throwIfAborted();
	const output = path.resolve(options.outputPath);
	if (path.extname(output).toLowerCase() !== ".mp4")
		throw new Error("Music output must have an .mp4 extension");
	const credits = `${output}.credits.txt`,
		provenance = `${output}.music.json`;
	for (const file of [output, credits, provenance]) await requireAbsent(file);
	const { track, audioPath } = await loadMusicManifest(
		manifestPath,
		options.signal,
	);
	const source = path.resolve(video);
	if (!(await fs.stat(source)).isFile())
		throw new Error("Music source video must be a local file");
	const media = await probeMusicMedia(
		source,
		"video",
		options.ffprobePath,
		options,
	);
	const audio = await probeMusicMedia(
		audioPath,
		"audio",
		options.ffprobePath,
		options,
	);
	const audibleDuration = settings.loop
		? media.duration
		: Math.min(media.duration, audio.duration);
	const fadeIn = Math.min(settings.fadeIn, audibleDuration),
		fadeOut = Math.min(settings.fadeOut, audibleDuration);
	const filters = [
		`volume=${settings.volume}`,
		`atrim=duration=${media.duration}`,
		`afade=t=in:st=0:d=${fadeIn}`,
		`afade=t=out:st=${Math.max(0, audibleDuration - fadeOut)}:d=${fadeOut}`,
		`apad=whole_dur=${media.duration}`,
		`atrim=duration=${media.duration}`,
	];
	await fs.mkdir(path.dirname(output), { recursive: true });
	const temporary = path.join(
		path.dirname(output),
		`.${path.basename(output)}.${randomUUID()}.partial.mp4`,
	);
	const temporaryCredits = `${temporary}.credits.txt`,
		temporaryProvenance = `${temporary}.music.json`;
	const published: string[] = [];
	try {
		await runMusicProcess(
			options.ffmpegPath ?? "ffmpeg",
			[
				"-nostdin",
				"-n",
				"-v",
				"error",
				...musicInputArgs,
				"-i",
				source,
				...(settings.loop ? ["-stream_loop", "-1"] : []),
				...musicInputArgs,
				"-i",
				audioPath,
				"-map",
				"0:v:0",
				"-map",
				"1:a:0",
				"-c:v",
				"copy",
				"-c:a",
				"aac",
				"-b:a",
				"192k",
				"-af",
				filters.join(","),
				"-t",
				String(media.duration),
				"-movflags",
				"+faststart",
				temporary,
			],
			options,
		);
		options.signal?.throwIfAborted();
		if ((await fs.stat(temporary)).size === 0)
			throw new Error("Music encoder produced an empty output");
		await probeMusicMedia(temporary, "audio", options.ffprobePath, {
			...options,
			allowVideo: true,
		});
		const changes = `Changes: synchronized to video; gain ${settings.volume}; fade in ${fadeIn}s; fade out ${fadeOut}s; ${settings.loop ? "looped" : "trimmed or padded with silence"}.`;
		await fs.writeFile(temporaryCredits, `${musicCredits(track)}${changes}\n`, {
			flag: "wx",
		});
		await fs.writeFile(
			temporaryProvenance,
			JSON.stringify(
				{
					version: 1,
					track,
					sourceManifest: path.resolve(manifestPath),
					mixedAt: new Date().toISOString(),
					durationSeconds: media.duration,
					settings,
					changes,
				},
				null,
				2,
			),
			{ flag: "wx" },
		);
		// Sidecars publish first; the MP4 is the final commit marker. Roll back only our links.
		for (const [from, to] of [
			[temporaryCredits, credits],
			[temporaryProvenance, provenance],
			[temporary, output],
		]) {
			options.signal?.throwIfAborted();
			await fs.link(from, to);
			published.push(to);
		}
		options.signal?.throwIfAborted();
	} catch (error) {
		for (const file of published) await fs.rm(file, { force: true });
		throw error;
	} finally {
		for (const file of [temporary, temporaryCredits, temporaryProvenance])
			await fs.rm(file, { force: true });
	}
};
