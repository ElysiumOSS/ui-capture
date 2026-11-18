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
// cspell:words matroska mjpeg

import { spawn } from "node:child_process";

/** Container allowlist prevents playlists from reading secondary files or URLs. */
export const musicInputArgs = [
	"-protocol_whitelist",
	"file,pipe",
	"-format_whitelist",
	"mp3,wav,ogg,flac,mov,matroska,webm,aac",
];
export interface MusicProcessOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}
/** Bounded output, total timeout and cancellation, settled after the process closes. */
export const runMusicProcess = (
	binary: string,
	args: string[],
	options: MusicProcessOptions = {},
): Promise<Buffer> =>
	new Promise((resolve, reject) => {
		const timeoutMs = options.timeoutMs ?? 120000;
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 900000) {
			reject(new Error("Music process timeout must be between 1 and 900000ms"));
			return;
		}
		if (options.signal?.aborted) {
			reject(new Error("Music processing cancelled"));
			return;
		}
		const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let size = 0;
		let stderr = Buffer.alloc(0);
		let failure: Error | undefined;
		const stop = (error: Error) => {
			failure ??= error;
			child.kill("SIGKILL");
		};
		const abort = () => stop(new Error("Music processing cancelled"));
		const timer = setTimeout(
			() => stop(new Error("Music processing timed out")),
			timeoutMs,
		);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > 1024 * 1024)
				stop(new Error("Music process output exceeded byte limit"));
			else chunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = Buffer.concat([stderr, chunk]).subarray(-16384);
		});
		child.on("error", (error) => {
			failure ??= error;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			if (failure) reject(failure);
			else if (code !== 0)
				reject(
					new Error(
						`Music process exited with code ${code}: ${stderr.toString().trim()}`,
					),
				);
			else resolve(Buffer.concat(chunks));
		});
	});
interface MediaStream {
	codec_type: string;
	codec_name: string;
	duration?: string;
}
export const probeMusicMedia = async (
	file: string,
	kind: "audio" | "video",
	ffprobePath = "ffprobe",
	options: MusicProcessOptions & { allowVideo?: boolean } = {},
): Promise<{ duration: number; format: string }> => {
	const bytes = await runMusicProcess(
		ffprobePath,
		[
			"-v",
			"error",
			...musicInputArgs,
			"-show_entries",
			"format=duration,format_name:stream=codec_type,codec_name,duration",
			"-of",
			"json",
			file,
		],
		{ ...options, timeoutMs: Math.min(options.timeoutMs ?? 15000, 15000) },
	);
	const result = JSON.parse(bytes.toString()) as {
		streams?: MediaStream[];
		format?: { duration?: string; format_name?: string };
	};
	const stream = result.streams?.find((item) => item.codec_type === kind);
	const duration = Number(stream?.duration ?? result.format?.duration);
	if (
		!stream ||
		!Number.isFinite(duration) ||
		duration <= 0 ||
		duration > 3600 ||
		!result.format?.format_name
	)
		throw new Error(
			`Expected a real ${kind} stream with duration between 0 and 3600 seconds`,
		);
	if (
		kind === "audio" &&
		!options.allowVideo &&
		result.streams?.some(
			(item) =>
				item.codec_type === "video" &&
				item.codec_name !== "mjpeg" &&
				item.codec_name !== "png",
		)
	)
		throw new Error("Music asset must be audio, not a video");
	return { duration, format: result.format.format_name };
};
