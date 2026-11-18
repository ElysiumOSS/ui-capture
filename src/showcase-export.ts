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
// cspell:words nostdin libx movflags faststart rawvideo

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type MusicMixSettings, mixMusic } from "./music-mix.js";

const FRAME_RATE = 30;
const MAX_RECORDING_SECONDS = 15 * 60 + 60;
const MAX_STDERR_BYTES = 16 * 1024;

/** Locate the first frame after the magenta/cyan/magenta marker at 30 fps. */
export const findMarkerEnd = (samples: Uint8Array): number => {
	let phase: "first" | "cyan" | "last" = "first";
	let consecutive = 0;
	for (let offset = 0; offset + 2 < samples.length; offset += 3) {
		const magenta =
			samples[offset] > 220 &&
			samples[offset + 1] < 40 &&
			samples[offset + 2] > 220;
		const cyan =
			samples[offset] < 40 &&
			samples[offset + 1] > 220 &&
			samples[offset + 2] > 220;
		if (phase === "first") {
			if (magenta) consecutive += 1;
			else if (cyan && consecutive >= 3) {
				phase = "cyan";
				consecutive = 1;
			} else consecutive = 0;
		} else if (phase === "cyan") {
			if (cyan) consecutive += 1;
			else if (magenta && consecutive >= 3) {
				phase = "last";
				consecutive = 1;
			} else {
				phase = "first";
				consecutive = magenta ? 1 : 0;
			}
		} else if (magenta) consecutive += 1;
		else if (consecutive >= 3) return (offset / 3 / FRAME_RATE) * 1000;
		else {
			phase = "first";
			consecutive = 0;
		}
	}
	throw new Error(
		"The source video has no complete showcase synchronization marker",
	);
};

/** Arguments remain separate from shell syntax, including caller-supplied paths. */
export const buildShowcaseFfmpegArgs = (
	sourcePath: string,
	outputPath: string,
	trimStartMs: number,
	durationMs: number,
): string[] => [
	"-nostdin",
	"-y",
	"-loglevel",
	"error",
	"-i",
	sourcePath,
	"-ss",
	(trimStartMs / 1000).toFixed(6),
	"-t",
	(durationMs / 1000).toFixed(6),
	"-map",
	"0:v:0",
	"-an",
	"-vf",
	"pad=ceil(iw/2)*2:ceil(ih/2)*2,fps=30",
	"-c:v",
	"libx264",
	"-preset",
	"medium",
	"-crf",
	"20",
	"-pix_fmt",
	"yuv420p",
	"-fps_mode",
	"cfr",
	"-movflags",
	"+faststart",
	outputPath,
];

interface CaptionScene {
	readonly caption?: string;
	readonly startMs: number;
	readonly endMs: number;
}

const srtTime = (ms: number): string => {
	const total = Math.max(0, Math.round(ms));
	const pad = (value: number, length = 2) =>
		String(value).padStart(length, "0");
	return `${pad(Math.floor(total / 3600000))}:${pad(Math.floor(total / 60000) % 60)}:${pad(Math.floor(total / 1000) % 60)},${pad(total % 1000, 3)}`;
};

/** Escape markup and remove blank lines, which otherwise split an SRT cue. */
export const createShowcaseSrt = (scenes: readonly CaptionScene[]): string => {
	let index = 0;
	return scenes
		.flatMap((scene) => {
			const caption = scene.caption?.trim();
			if (!caption || scene.endMs <= scene.startMs) return [];
			const text = caption
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;")
				.split(/\r?\n/)
				.filter((line) => line.trim())
				.join("\n");
			return [
				`${++index}\n${srtTime(scene.startMs)} --> ${srtTime(scene.endMs)}\n${text}\n`,
			];
		})
		.join("\n");
};

export interface ShowcaseExportOptions {
	readonly ffmpegPath: string;
	readonly sourcePath: string;
	readonly outputPath: string;
	readonly durationMs: number;
	readonly soundtrack?: string;
	readonly music?: MusicMixSettings;
	readonly ffprobePath?: string;
	readonly signal?: AbortSignal;
	/** Shared budget for marker detection and encoding. */
	readonly timeoutMs?: number;
}

const abortError = (): Error => new Error("Showcase export was cancelled");

/** Resolve only after close: the child has exited and all its pipes are closed. */
const runEncoder = (
	binary: string,
	args: readonly string[],
	deadline: number,
	signal: AbortSignal | undefined,
	maxOutputBytes: number,
): Promise<Buffer> =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const remaining = deadline - performance.now();
		if (remaining <= 0) {
			reject(new Error("Showcase encoder timed out"));
			return;
		}
		const child = spawn(binary, [...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const output: Buffer[] = [];
		let outputSize = 0;
		let stderr = Buffer.alloc(0);
		let failure: Error | undefined;
		const stop = (error: Error) => {
			failure ??= error;
			child.kill("SIGKILL");
		};
		const onAbort = () => stop(abortError());
		const timer = setTimeout(
			() => stop(new Error("Showcase encoder timed out")),
			remaining,
		);
		signal?.addEventListener("abort", onAbort, { once: true });
		// A cancellation between the pre-spawn check and listener registration counts too.
		if (signal?.aborted) onAbort();
		child.stdout.on("data", (chunk: Buffer) => {
			outputSize += chunk.length;
			if (outputSize > maxOutputBytes)
				stop(new Error("Showcase encoder exceeded its output limit"));
			else output.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = Buffer.concat([stderr, chunk]).subarray(-MAX_STDERR_BYTES);
		});
		child.on("error", (error) => {
			failure ??= error;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (failure) reject(failure);
			else if (code !== 0)
				reject(
					new Error(
						`Showcase encoder exited with code ${code}: ${stderr.toString().trim()}`,
					),
				);
			else resolve(Buffer.concat(output));
		});
	});

/** Export once, publishing a complete MP4 atomically without replacing an old one. */
export const exportShowcase = async (
	options: ShowcaseExportOptions,
): Promise<{ trimStartMs: number; durationMs: number }> => {
	const { ffmpegPath, sourcePath, outputPath, durationMs, signal } = options;
	if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 900000)
		throw new Error(
			"Showcase durationMs must be greater than zero and at most 900000",
		);
	const timeoutMs = options.timeoutMs ?? 120000;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 900000)
		throw new Error(
			"Showcase encoder timeoutMs must be greater than zero and at most 900000",
		);
	if (signal?.aborted) throw abortError();
	if (
		await fs.lstat(outputPath).then(
			() => true,
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return false;
				throw error;
			},
		)
	)
		throw new Error(`Showcase output already exists: ${outputPath}`);
	const deadline = performance.now() + timeoutMs;
	const temporaryPath = path.join(
		path.dirname(outputPath),
		`.${path.basename(outputPath)}.${randomUUID()}.partial.mp4`,
	);
	try {
		const pixels = await runEncoder(
			ffmpegPath,
			[
				"-nostdin",
				"-loglevel",
				"error",
				"-i",
				sourcePath,
				"-t",
				String(MAX_RECORDING_SECONDS),
				"-map",
				"0:v:0",
				"-an",
				"-vf",
				"crop=16:16:0:0,scale=1:1,fps=30",
				"-f",
				"rawvideo",
				"-pix_fmt",
				"rgb24",
				"pipe:1",
			],
			deadline,
			signal,
			(MAX_RECORDING_SECONDS * FRAME_RATE + 1) * 3,
		);
		const trimStartMs = findMarkerEnd(pixels);
		const availableMs = (pixels.length / 3 / FRAME_RATE) * 1000 - trimStartMs;
		if (availableMs + 1000 / FRAME_RATE < durationMs) {
			throw new Error(
				`Source video ended before the tour duration: ${Math.round(availableMs)}ms available, ${durationMs}ms required`,
			);
		}
		await runEncoder(
			ffmpegPath,
			buildShowcaseFfmpegArgs(
				sourcePath,
				temporaryPath,
				trimStartMs,
				durationMs,
			),
			deadline,
			signal,
			1024,
		);
		if (signal?.aborted) throw abortError();
		if ((await fs.stat(temporaryPath)).size === 0)
			throw new Error("Showcase encoder produced an empty MP4");
		if (signal?.aborted) throw abortError();
		// A hard link publishes atomically and fails if another run won the name.
		// Unlike rename, it cannot overwrite a pre-existing result in that race.
		if (options.soundtrack) {
			await mixMusic(temporaryPath, options.soundtrack, {
				outputPath,
				ffmpegPath,
				ffprobePath: options.ffprobePath,
				...options.music,
				signal,
				timeoutMs: Math.max(1, deadline - performance.now()),
			});
		} else await fs.link(temporaryPath, outputPath);
		return {
			trimStartMs,
			durationMs:
				(Math.ceil((durationMs * FRAME_RATE) / 1000) * 1000) / FRAME_RATE,
		};
	} finally {
		await fs.rm(temporaryPath, { force: true });
	}
};
