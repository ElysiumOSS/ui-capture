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

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readMusicUrl, safeMusicUrl } from "./music-http.js";
import { type MusicProcessOptions, probeMusicMedia } from "./music-process.js";
import {
	type MusicTrack,
	musicCredits,
	musicId,
	musicSearchUrl,
	musicText,
	parseOpenverseTrack,
	renderMusicPreview,
	validateOpenverseLicense,
} from "./music-provider.js";

export type { MusicTrack } from "./music-provider.js";
export interface MusicAssetOptions extends MusicProcessOptions {
	readonly outputDir: string;
	readonly ffprobePath?: string;
}
export interface MusicManifest extends MusicTrack {
	readonly version: 1;
	readonly audio: string;
	readonly sha256: string;
	readonly retrievedAt: string;
	readonly durationSeconds: number;
}
export interface ImportMusicOptions extends MusicAssetOptions {
	readonly title: string;
	readonly creator: string;
	readonly sourceUrl: string;
	readonly license: string;
	readonly licenseUrl: string;
	readonly licenseVersion?: string;
	readonly attribution?: string;
}
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
/** Reserve a fresh directory and publish its manifest last; failure removes owned files. */
const newMusicDirectory = async <T>(
	outputDir: string,
	signal: AbortSignal | undefined,
	write: (directory: string) => Promise<T>,
): Promise<T> => {
	signal?.throwIfAborted();
	const directory = path.resolve(outputDir);
	await fs.mkdir(path.dirname(directory), { recursive: true });
	try {
		await fs.mkdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new Error(
				`Music output already exists: ${directory}; choose a new output directory`,
			);
		throw error;
	}
	try {
		const result = await write(directory);
		signal?.throwIfAborted();
		return result;
	} catch (error) {
		await fs.rm(directory, { recursive: true, force: true });
		throw error;
	}
};
const hashMusicFile = async (
	file: string,
	signal?: AbortSignal,
): Promise<string> => {
	const stat = await fs.stat(file);
	if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_AUDIO_BYTES)
		throw new Error("Music audio file must be nonempty and at most 100 MiB");
	signal?.throwIfAborted();
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(file, { signal }))
		hash.update(chunk);
	return hash.digest("hex");
};
const saveAsset = async (
	directory: string,
	temporary: string,
	track: MusicTrack,
	options: MusicAssetOptions,
): Promise<MusicManifest> => {
	const media = await probeMusicMedia(
		temporary,
		"audio",
		options.ffprobePath,
		options,
	);
	const extension =
		media.format
			.split(",")
			.find((name) => ["wav", "mp3", "ogg", "flac", "aac"].includes(name)) ??
		(media.format.includes("mov") ? "m4a" : "webm");
	const audio = `audio.${extension}`;
	const manifest: MusicManifest = {
		...track,
		version: 1,
		audio,
		sha256: await hashMusicFile(temporary, options.signal),
		retrievedAt: new Date().toISOString(),
		durationSeconds: media.duration,
	};
	await fs.link(temporary, path.join(directory, audio));
	await fs.unlink(temporary);
	await fs.writeFile(path.join(directory, "credits.txt"), musicCredits(track), {
		flag: "wx",
	});
	await fs.writeFile(
		path.join(directory, "index.html"),
		renderMusicPreview([track], audio),
		{ flag: "wx" },
	);
	options.signal?.throwIfAborted();
	const staged = path.join(directory, ".track.partial");
	const serialized = JSON.stringify(manifest, null, 2);
	if (Buffer.byteLength(serialized) > 65536)
		throw new Error("Music manifest exceeds byte limit");
	await fs.writeFile(staged, serialized);
	await fs.link(staged, path.join(directory, "track.json"));
	await fs.unlink(staged);
	return manifest;
};
/** Search one Openverse music page and save native browser previews. */
export const searchMusic = async (
	query: string,
	options: {
		readonly outputDir: string;
		readonly limit?: number;
		readonly signal?: AbortSignal;
	},
): Promise<MusicTrack[]> => {
	const url = musicSearchUrl(query, options.limit);
	const raw = JSON.parse(
		(
			await readMusicUrl(url.href, { kind: "json", signal: options.signal })
		).toString(),
	) as { results?: unknown[] };
	if (!Array.isArray(raw.results))
		throw new Error("Openverse response has no results array");
	const tracks = raw.results.slice(0, options.limit ?? 10).flatMap((value) => {
		try {
			return [parseOpenverseTrack(value)];
		} catch {
			return [];
		}
	});
	return newMusicDirectory(
		options.outputDir,
		options.signal,
		async (directory) => {
			await fs.writeFile(
				path.join(directory, "index.html"),
				renderMusicPreview(tracks),
				{ flag: "wx" },
			);
			options.signal?.throwIfAborted();
			await fs.writeFile(
				path.join(directory, "results.json"),
				JSON.stringify(
					{ query, retrievedAt: new Date().toISOString(), tracks },
					null,
					2,
				),
				{ flag: "wx" },
			);
			return tracks;
		},
	);
};
/** Fetch fresh selected metadata, then download exactly one audio file. */
export const fetchMusic = async (
	id: string,
	options: MusicAssetOptions,
): Promise<MusicManifest> => {
	musicId(id);
	const track = parseOpenverseTrack(
		JSON.parse(
			(
				await readMusicUrl(`https://api.openverse.org/v1/audio/${id}/`, {
					kind: "json",
					signal: options.signal,
				})
			).toString(),
		),
	);
	if (track.id.toLowerCase() !== id.toLowerCase())
		throw new Error("Openverse returned a different music ID");
	return newMusicDirectory(
		options.outputDir,
		options.signal,
		async (directory) => {
			const temporary = path.join(directory, ".audio.partial");
			await readMusicUrl(track.audioUrl ?? "", {
				kind: "audio",
				signal: options.signal,
				destination: temporary,
			});
			return saveAsset(directory, temporary, track, options);
		},
	);
};
/** Import audio the caller is authorized to use, retaining its supplied license evidence. */
export const importMusic = async (
	file: string,
	options: ImportMusicOptions,
): Promise<MusicManifest> => {
	const title = musicText(options.title, "title");
	const creator = musicText(options.creator, "creator");
	const track: MusicTrack = {
		id: randomUUID(),
		provider: "manual",
		title,
		creator,
		sourceUrl: safeMusicUrl(musicText(options.sourceUrl, "source URL")).href,
		license: musicText(options.license, "license"),
		licenseUrl: safeMusicUrl(musicText(options.licenseUrl, "license URL")).href,
		licenseVersion: options.licenseVersion ?? "",
		attribution: options.attribution
			? musicText(options.attribution, "attribution")
			: `${title} by ${creator}`,
	};
	if (
		typeof track.licenseVersion !== "string" ||
		track.licenseVersion.length > 30
	)
		throw new Error("Invalid music license version");
	if (track.licenseVersion) musicText(track.licenseVersion, "license version");
	musicText(track.attribution, "attribution");
	const remote = /^https?:\/\//i.test(file);
	const source = remote ? safeMusicUrl(file).href : path.resolve(file);
	if (!remote) await hashMusicFile(source, options.signal);
	return newMusicDirectory(
		options.outputDir,
		options.signal,
		async (directory) => {
			const temporary = path.join(directory, ".audio.partial");
			if (remote)
				await readMusicUrl(source, {
					kind: "audio",
					signal: options.signal,
					destination: temporary,
				});
			else await fs.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
			return saveAsset(directory, temporary, track, options);
		},
	);
};
/** Validate all user-controlled metadata, a contained local path, and the file digest. */
export const loadMusicManifest = async (
	file: string,
	signal?: AbortSignal,
): Promise<{ track: MusicManifest; audioPath: string }> => {
	signal?.throwIfAborted();
	const source = path.resolve(file);
	if ((await fs.stat(source)).size > 65536)
		throw new Error("Music manifest exceeds byte limit");
	const raw = JSON.parse(await fs.readFile(source, "utf8")) as Record<
		string,
		unknown
	>;
	if (
		raw.version !== 1 ||
		!["manual", "openverse"].includes(String(raw.provider))
	)
		throw new Error("Unsupported music manifest");
	for (const field of [
		"id",
		"title",
		"creator",
		"sourceUrl",
		"license",
		"licenseUrl",
		"attribution",
		"retrievedAt",
		"audio",
		"sha256",
	])
		musicText(raw[field], field);
	musicId(raw.id);
	safeMusicUrl(raw.sourceUrl as string);
	safeMusicUrl(raw.licenseUrl as string);
	if (
		typeof raw.licenseVersion !== "string" ||
		raw.licenseVersion.length > 30 ||
		!Number.isFinite(Date.parse(raw.retrievedAt as string)) ||
		typeof raw.durationSeconds !== "number" ||
		raw.durationSeconds <= 0 ||
		raw.durationSeconds > 3600
	)
		throw new Error("Invalid music manifest metadata");
	if (raw.provider === "openverse")
		validateOpenverseLicense(
			raw.license as string,
			raw.licenseVersion,
			raw.licenseUrl as string,
		);
	const audio = raw.audio as string;
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(audio) || audio === "..")
		throw new Error(
			"Music audio path must be a relative filename inside the manifest directory",
		);
	const directory = await fs.realpath(path.dirname(source));
	const audioPath = await fs.realpath(path.join(directory, audio));
	if (path.dirname(audioPath) !== directory)
		throw new Error("Music audio path resolves outside the manifest directory");
	if (
		!/^[a-f0-9]{64}$/.test(raw.sha256 as string) ||
		(await hashMusicFile(audioPath, signal)) !== raw.sha256
	)
		throw new Error("Music audio SHA-256 hash does not match its manifest");
	return { track: raw as unknown as MusicManifest, audioPath };
};
