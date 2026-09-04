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
import path from "node:path";
import { promisify } from "node:util";
import { Effect, Schedule } from "effect";
import { FileSystemError } from "./errors.js";

export type RouteTask = {
	readonly type: "route";
	readonly url: string;
	readonly depth: number;
	readonly normalizedUrl: string;
};

/**
 * One scripted state, queued as a first-class peer of a route rather than a
 * phase bolted onto the end of a crawl: same queue, same worker pool, same
 * `--concurrency`, same results map, same report.
 */
export type StateTask = {
	readonly type: "state";
	readonly url: string;
	readonly stateName: string;
	/**
	 * Where the state's result lands. A state is a capture leaf — it never
	 * feeds the crawl frontier and is never deduplicated by URL — so the
	 * normalized URL a `RouteTask` needs has no reader here, and carrying one
	 * would only invite a caller to key a state by it and collide with the
	 * route capture for the same page.
	 */
	readonly resultKey: string;
};

export type ShutdownTask = {
	readonly type: "shutdown";
};

export type QueueTask = RouteTask | StateTask | ShutdownTask;

export const ShutdownSignal: ShutdownTask = { type: "shutdown" } as const;

/**
 * Best-effort teardown, for the release half of an `acquireUseRelease`.
 *
 * Closing a context or a page is what reaps its browser-side resources — and
 * for a recording context, what flushes the video to disk — so it has to run
 * on every exit path, including an interrupted one. It must never fail: a
 * `close()` that rejects on an already-dead target would otherwise replace the
 * real error with a teardown error and lose the reason the run stopped.
 *
 * Lives here because both the service (state and worker contexts, worker
 * pages) and the video recorder need exactly this, and two copies are two
 * chances for one of them to start reporting its failures.
 */
export const closeQuietly = (
	close: () => Promise<unknown>,
): Effect.Effect<void> =>
	Effect.tryPromise({ try: close, catch: () => undefined }).pipe(
		Effect.catchAll(() => Effect.void),
	);

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
	hydrate: (primaryHost: string, extraAllowedHosts: readonly string[]) => void;
	hostMatchesFilters: (hostname: string, includeSubdomains: boolean) => boolean;
}

export const createHostFilterState = (): HostFilterState => {
	let allowedHostnames = new Set<string>();
	let hostSuffixes = new Set<string>();

	return {
		hydrate: (primaryHost, extraAllowedHosts) => {
			const configured = extraAllowedHosts.map(canonicalizeHost);
			const primary = canonicalizeHost(primaryHost);
			allowedHostnames = new Set([primary, ...configured].filter(Boolean));
			// Drop bare-TLD suffixes (e.g. "com") so an allow-listed
			// "example.com" with includeSubdomains=true does not also match
			// every other ".com" host. A registered domain needs at least
			// one dot to be a meaningful suffix.
			hostSuffixes = new Set(
				Array.from(allowedHostnames).flatMap((host) =>
					computeHostSuffixes(host).filter((suffix) => suffix.includes(".")),
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

/**
 * The origin gate for the two decisions that let a run *act* on a URL: a
 * scripted state's entry `url`, and the URL a `request` step resolves to.
 *
 * An origin is **scheme + host + port**, so that is what gets compared:
 * `hostMatchesFilters` decides the host (it canonicalizes `www.` and honors
 * `--allowed-hosts` / `--include-subdomains`), and the seed decides the scheme
 * and the port. Matching on hostname alone let `http://app.test:4000` through
 * a filter whose whole purpose was to confine a run to `https://app.test` —
 * a different port and a downgraded scheme are different servers, and for a
 * `request` step that means a POST at a machine the user never named.
 *
 * `URL.port` is already normalized (`""` for a scheme's default), so
 * `https://a.test` and `https://a.test:443` compare equal without special
 * casing.
 *
 * Both the pre-launch validation in `states.ts` and the runtime request gate
 * in the state driver call this, so a states file that validates cannot be
 * widened at runtime and a run cannot abort on something the runtime would
 * have allowed.
 *
 * **Route crawling deliberately does not use this gate.** `scheduleRoute` in
 * `service.ts` and the link filter in `link-discovery.ts` match on the
 * hostname alone, so a crawl seeded at `http://app.test:3000` will follow and
 * capture a link to `https://app.test` or `http://app.test:8080`. The two
 * answer different questions: crawling navigates and screenshots, and within
 * one deployment an http→https or cross-port link is ordinary rather than
 * suspicious, while this gate authorizes driving a scripted state at a URL and
 * sending a `request` step's POST or DELETE at it. `--allowed-hosts` and
 * `--include-subdomains` are documented as hostname filters, and hostname is
 * what bounds a crawl.
 */
export const isAllowedOrigin = (
	candidate: URL,
	seed: URL,
	hostMatchesFilters: (hostname: string) => boolean,
): boolean =>
	candidate.protocol === seed.protocol &&
	candidate.port === seed.port &&
	hostMatchesFilters(candidate.hostname);

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

/**
 * Keys a scripted-state result so it can never overwrite the route result for
 * the same URL, nor another state's result on that URL.
 */
export const stateResultKey = (url: string, stateName: string): string =>
	`${normalizeUrl(url)}::state=${stateName}`;

/**
 * Where one capture unit's `screenshots/` and `videos/` live.
 *
 * A scripted state nests under the route it belongs to
 * (`<route>/states/<name>/`) rather than encoding both axes in one slug: the
 * route/state relationship stays visible in the tree, and a future capture
 * axis does not have to fight a separator convention. Everything downstream
 * treats this as an opaque prefix.
 */
export const getCaptureDir = (
	outputDir: string,
	url: string,
	stateName?: string,
): string => {
	const routeDir = path.join(outputDir, getRouteName(url));
	return stateName ? path.join(routeDir, "states", stateName) : routeDir;
};
