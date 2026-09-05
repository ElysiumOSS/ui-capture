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
import fs from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import type { Browser, BrowserContext, Page } from "playwright";
import { CaptureError, FileSystemError } from "./errors.js";
import { VideoQualityPaths, type ViewportConfig } from "./schemas.js";
import {
	captureRetryPolicy,
	closeQuietly,
	navigationRetryPolicy,
	transcodeVideo,
	VIDEO_QUALITY_PROFILES,
} from "./shared.js";

export interface CaptureVideoConfig {
	readonly waitTime: number;
	readonly ffmpegPath: string;
	readonly videoOptions: {
		readonly duration: number;
		readonly interactions: boolean;
	};
	/** Must match the screenshot context, or a run's stills and video disagree. */
	readonly colorScheme: "light" | "dark" | "no-preference";
	readonly ignoreHttpsErrors: boolean;
	/**
	 * Where the capture began — the URL the recording context navigates to
	 * before {@link prepare} replays the script.
	 *
	 * Deliberately supplied by the caller rather than read off the page being
	 * captured: by the time video runs, a scripted state has already driven
	 * that page, so its current URL is where the script *ended*. Replaying the
	 * script from there records the wrong thing — a step that navigates would
	 * run from the wrong entry point, and a first step that assumes the entry
	 * view fails outright.
	 */
	readonly startUrl: string;
	/**
	 * Replays a scripted state inside the recording context.
	 *
	 * Without it the video context would navigate and record the *unscripted*
	 * boot view while the stills show the scripted state — the two silently
	 * disagreeing. Undefined for route captures, so existing behaviour is
	 * untouched.
	 */
	readonly prepare?: (page: Page) => Effect.Effect<void, CaptureError>;
}

export const captureVideoForViewport = (
	browser: Browser,
	viewport: ViewportConfig,
	routeDir: string,
	timestamp: string,
	cfg: CaptureVideoConfig,
): Effect.Effect<VideoQualityPaths, CaptureError | FileSystemError> =>
	Effect.gen(function* () {
		const url = cfg.startUrl;
		const baseFilename = `${viewport.name}_${viewport.width}x${viewport.height}_${timestamp}`;
		const masterProfile = VIDEO_QUALITY_PROFILES[0];
		const masterPath = path.join(
			routeDir,
			"videos",
			masterProfile.dir,
			`${baseFilename}.webm`,
		);

		const acquireContext = Effect.tryPromise({
			try: () =>
				browser.newContext({
					recordVideo: {
						dir: path.join(routeDir, "videos", masterProfile.dir),
						size: {
							width: Math.floor(viewport.width * masterProfile.scale),
							height: Math.floor(viewport.height * masterProfile.scale),
						},
					},
					viewport: { width: viewport.width, height: viewport.height },
					colorScheme: cfg.colorScheme,
					ignoreHTTPSErrors: cfg.ignoreHttpsErrors,
				}),
			catch: (error) =>
				new CaptureError({
					url,
					message: "Failed to create master video context",
					cause: error,
				}),
		}).pipe(Effect.retry(captureRetryPolicy));

		const record = (context: BrowserContext) =>
			Effect.gen(function* () {
				const videoPage = yield* Effect.tryPromise({
					try: () => context.newPage(),
					catch: (error) =>
						new CaptureError({
							url,
							message: "Failed to create video page",
							cause: error,
						}),
				}).pipe(Effect.retry(captureRetryPolicy));

				yield* Effect.tryPromise({
					try: () =>
						videoPage.goto(url, {
							waitUntil: "networkidle",
							timeout: 30000,
						}),
					catch: (error) =>
						new CaptureError({
							url,
							message: "Failed to navigate video page",
							cause: error,
						}),
				}).pipe(Effect.retry(navigationRetryPolicy));

				yield* Effect.sleep(cfg.waitTime);

				if (cfg.prepare) {
					yield* cfg.prepare(videoPage);
				}

				if (cfg.videoOptions.interactions) {
					const scrollSteps = 5;
					const scrollDelay = cfg.videoOptions.duration / (scrollSteps + 1);

					for (let i = 0; i < scrollSteps; i++) {
						yield* Effect.tryPromise({
							try: () =>
								videoPage.evaluate((step: number) => {
									window.scrollTo({
										top: (document.body.scrollHeight / 5) * step,
										behavior: "smooth",
									});
								}, i + 1),
							catch: (error) =>
								new CaptureError({
									url,
									message: "Failed to run scroll interaction",
									cause: error,
								}),
						}).pipe(Effect.catchAll(() => Effect.void));
						yield* Effect.sleep(scrollDelay);
					}

					yield* Effect.tryPromise({
						try: () =>
							videoPage.evaluate(() => {
								window.scrollTo({ top: 0, behavior: "smooth" });
							}),
						catch: (error) =>
							new CaptureError({
								url,
								message: "Failed to reset scroll position",
								cause: error,
							}),
					}).pipe(Effect.catchAll(() => Effect.void));
					yield* Effect.sleep(1000);
				} else {
					yield* Effect.sleep(cfg.videoOptions.duration);
				}

				yield* closeQuietly(() => videoPage.close());

				return yield* Effect.tryPromise({
					try: async () => await videoPage.video()?.path(),
					catch: (error) =>
						new CaptureError({
							url,
							message: "Failed to finalize video recording",
							cause: error,
						}),
				});
			});

		// The rename has to happen after the context is closed, because that is
		// when Playwright flushes the recording to disk — so the whole recording
		// lives inside acquire/use/release and only the path escapes it.
		// Closing the context is what finalizes the recording and reaps its
		// ffmpeg pipe, so it has to run on *every* exit — a failed navigation, a
		// replay that throws, an interrupted run. Leaking it leaks a live browser
		// context, and with it a recording that is never flushed, per capture.
		const rawVideoPath = yield* Effect.acquireUseRelease(
			acquireContext,
			record,
			(context: BrowserContext) => closeQuietly(() => context.close()),
		);

		if (!rawVideoPath) {
			return yield* Effect.fail(
				new CaptureError({
					url,
					message: "Video path is null",
					cause: null,
				}),
			);
		}

		yield* Effect.tryPromise({
			try: () => fs.rename(rawVideoPath, masterPath),
			catch: (error) =>
				new FileSystemError({
					path: masterPath,
					operation: "rename",
					cause: error,
				}),
		});

		const videoPaths: Record<"high" | "medium" | "low", string> = {
			high: masterPath,
			medium: masterPath,
			low: masterPath,
		};

		for (const profile of VIDEO_QUALITY_PROFILES.slice(1)) {
			const targetPath = path.join(
				routeDir,
				"videos",
				profile.dir,
				`${baseFilename}.webm`,
			);
			const transcodeSucceeded = yield* transcodeVideo(
				cfg.ffmpegPath,
				masterPath,
				targetPath,
				profile.scale,
			).pipe(
				Effect.as(true),
				Effect.catchAll((error) => {
					console.error(
						`Failed to transcode ${profile.name} quality video:`,
						error,
					);
					return Effect.succeed(false);
				}),
			);

			if (transcodeSucceeded) {
				videoPaths[profile.name] = targetPath;
			}
		}

		console.log(`    ✓ Video recorded for ${viewport.name}`);

		return new VideoQualityPaths(videoPaths);
	});
