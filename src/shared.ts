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
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Effect, Schedule } from "effect";
import { FileSystemError } from "./errors.js";

export type RouteTask = {
	readonly type: "route";
	readonly url: string;
	readonly depth: number;
	readonly normalizedUrl: string;
};

export type ShutdownTask = {
	readonly type: "shutdown";
};

export type QueueTask = RouteTask | ShutdownTask;

export const ShutdownSignal: ShutdownTask = { type: "shutdown" } as const;

export const LINK_FILTER_CONCURRENCY = 32;
export const navigationRetryPolicy = Schedule.recurs(3);
export const captureRetryPolicy = Schedule.recurs(2);

export const VIDEO_QUALITY_PROFILES = [
	{ name: "high" as const, scale: 1, dir: "high-quality", transcode: false },
	{
		name: "medium" as const,
		scale: 0.75,
		dir: "medium-quality",
		transcode: true,
	},
	{ name: "low" as const, scale: 0.5, dir: "low-quality", transcode: true },
] as const;

const execFileAsync = promisify(execFile);

export const transcodeVideo = (
	ffmpegPath: string,
	inputPath: string,
	outputPath: string,
	scale: number,
): Effect.Effect<void, FileSystemError> =>
	Effect.tryPromise({
		try: async () => {
			await execFileAsync(ffmpegPath, [
				"-y",
				"-i",
				inputPath,
				"-vf",
				`scale=iw*${scale}:-2`,
				"-c:v",
				"libvpx-vp9",
				"-b:v",
				"0",
				outputPath,
			]);
		},
		catch: (error) =>
			new FileSystemError({
				path: outputPath,
				operation: "ffmpeg-transcode",
				cause: error,
			}),
	});

/**
 * Pipes an in-memory image buffer through ffmpeg stdin and writes the encoded
 * result to disk. Avoids an intermediate temp file. Used to produce real WebP
 * (and re-encoded JPEG) from a single PNG screenshot buffer.
 */
export const pipeImageThroughFfmpeg = (
	ffmpegPath: string,
	inputBuffer: Buffer,
	outputPath: string,
	codecArgs: readonly string[],
): Effect.Effect<void, FileSystemError> =>
	Effect.tryPromise({
		try: () =>
			new Promise<void>((resolve, reject) => {
				const proc = spawn(ffmpegPath, [
					"-y",
					"-loglevel",
					"error",
					"-f",
					"image2pipe",
					"-i",
					"pipe:0",
					...codecArgs,
					outputPath,
				]);
				let stderr = "";
				proc.stderr.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				proc.on("error", reject);
				proc.on("close", (code) => {
					if (code === 0) {
						resolve();
					} else {
						reject(
							new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`),
						);
					}
				});
				proc.stdin.on("error", reject);
				proc.stdin.end(inputBuffer);
			}),
		catch: (error) =>
			new FileSystemError({
				path: outputPath,
				operation: "ffmpeg-pipe",
				cause: error,
			}),
	});

export const canonicalizeHost = (host: string): string =>
	host
		.trim()
		.replace(/^https?:\/\//i, "")
		.replace(/\/.*$/, "")
		.replace(/^www\./i, "")
		.toLowerCase();

export const computeHostSuffixes = (host: string): readonly string[] => {
	const segments = canonicalizeHost(host).split(".").filter(Boolean);
	const suffixes: string[] = [];
	for (let i = 0; i < segments.length; i++) {
		suffixes.push(segments.slice(i).join("."));
	}
	return suffixes;
};

export interface HostFilterState {
	hydrate: (
		primaryHost: string,
		extraAllowedHosts: readonly string[],
	) => void;
	hostMatchesFilters: (
		hostname: string,
		includeSubdomains: boolean,
	) => boolean;
}

export const createHostFilterState = (): HostFilterState => {
	let allowedHostnames = new Set<string>();
	let hostSuffixes = new Set<string>();

	return {
		hydrate: (primaryHost, extraAllowedHosts) => {
			const configured = extraAllowedHosts.map(canonicalizeHost);
			const primary = canonicalizeHost(primaryHost);
			allowedHostnames = new Set([primary, ...configured].filter(Boolean));
			hostSuffixes = new Set(
				Array.from(allowedHostnames).flatMap((host) =>
					computeHostSuffixes(host),
				),
			);
		},
		hostMatchesFilters: (hostname, includeSubdomains) => {
			const normalized = canonicalizeHost(hostname);
			if (allowedHostnames.has(normalized)) return true;
			if (!includeSubdomains) return false;
			for (const suffix of hostSuffixes) {
				if (normalized === suffix || normalized.endsWith(`.${suffix}`)) {
					return true;
				}
			}
			return false;
		},
	};
};

export const normalizeUrl = (url: string): string => {
	try {
		const u = new URL(url);
		const normalized = `${u.origin}${u.pathname}`.replace(/\/$/, "");
		return normalized || `${u.origin}/`;
	} catch {
		return url;
	}
};

export const getRouteName = (url: string): string => {
	try {
		const u = new URL(url);
		return (
			u.pathname
				.replace(/^\/|\/$/g, "")
				.replace(/[^a-z0-9]/gi, "-")
				.replace(/-+/g, "-")
				.toLowerCase() || "root"
		);
	} catch {
		return "invalid-url";
	}
};
