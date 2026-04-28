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
import type { Browser, Page } from "playwright";
import { CaptureError, FileSystemError } from "./errors.js";
import { VideoQualityPaths, type ViewportConfig } from "./schemas.js";
import {
	captureRetryPolicy,
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
}

export const captureVideoForViewport = (
	browser: Browser,
	referencePage: Page,
	viewport: ViewportConfig,
	routeDir: string,
	timestamp: string,
	cfg: CaptureVideoConfig,
): Effect.Effect<VideoQualityPaths, CaptureError | FileSystemError> =>
	Effect.gen(function* () {
		const baseFilename = `${viewport.name}_${viewport.width}x${viewport.height}_${timestamp}`;
		const masterProfile = VIDEO_QUALITY_PROFILES[0];
		const masterPath = path.join(
			routeDir,
			"videos",
			masterProfile.dir,
			`${baseFilename}.webm`,
		);

		const context = yield* Effect.tryPromise({
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
				}),
			catch: (error) =>
				new CaptureError({
					url: referencePage.url(),
					message: "Failed to create master video context",
					cause: error,
				}),
		}).pipe(Effect.retry(captureRetryPolicy));

		const videoPage = yield* Effect.tryPromise({
			try: () => context.newPage(),
			catch: (error) =>
				new CaptureError({
					url: referencePage.url(),
					message: "Failed to create video page",
					cause: error,
				}),
		}).pipe(Effect.retry(captureRetryPolicy));

		yield* Effect.tryPromise({
			try: () =>
				videoPage.goto(referencePage.url(), {
					waitUntil: "networkidle",
					timeout: 30000,
				}),
			catch: (error) =>
				new CaptureError({
					url: referencePage.url(),
					message: "Failed to navigate video page",
					cause: error,
				}),
		}).pipe(Effect.retry(navigationRetryPolicy));

		yield* Effect.sleep(cfg.waitTime);

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
							url: referencePage.url(),
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
						url: referencePage.url(),
						message: "Failed to reset scroll position",
						cause: error,
					}),
			}).pipe(Effect.catchAll(() => Effect.void));
			yield* Effect.sleep(1000);
		} else {
			yield* Effect.sleep(cfg.videoOptions.duration);
		}

		yield* Effect.tryPromise({
			try: () => videoPage.close(),
			catch: (error) =>
				new CaptureError({
					url: referencePage.url(),
					message: "Failed to close video page",
					cause: error,
				}),
		}).pipe(Effect.catchAll(() => Effect.void));

		const rawVideoPath = yield* Effect.tryPromise({
			try: async () => {
				const vp = await videoPage.video()?.path();
				await context.close();
				return vp;
			},
			catch: (error) =>
				new CaptureError({
					url: referencePage.url(),
					message: "Failed to finalize video recording",
					cause: error,
				}),
		});

		if (!rawVideoPath) {
			return yield* Effect.fail(
				new CaptureError({
					url: referencePage.url(),
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
