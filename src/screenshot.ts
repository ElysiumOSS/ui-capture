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
import type { Page } from "playwright";
import { CaptureError, FileSystemError } from "./errors.js";
import { ScreenshotPaths, type ViewportConfig } from "./schemas.js";
import { captureRetryPolicy, pipeImageThroughFfmpeg } from "./shared.js";

export interface CaptureScreenshotsConfig {
	readonly ffmpegPath: string;
	readonly screenshotHideSelectors: ReadonlyArray<string>;
	readonly webpQuality?: number;
	readonly jpgQuality?: number;
}

const acquireMaskStyle = (
	page: Page,
	selectors: ReadonlyArray<string>,
): Effect.Effect<string | null, CaptureError> =>
	selectors.length === 0
		? Effect.succeed<string | null>(null)
		: Effect.tryPromise({
				try: async () => {
					const styleId = `ui-capture-mask-${Date.now().toString(36)}-${Math.random()
						.toString(36)
						.slice(2)}`;
					await page.evaluate(
						(args: { id: string; selectors: readonly string[] }) => {
							const css = args.selectors
								.map(
									(selector) =>
										`${selector} { visibility: hidden !important; opacity: 0 !important; }`,
								)
								.join("\n");
							const style = document.createElement("style");
							style.id = args.id;
							style.textContent = css;
							document.head.appendChild(style);
						},
						{ id: styleId, selectors },
					);
					return styleId;
				},
				catch: (error) =>
					new CaptureError({
						url: page.url(),
						message: "Failed to hide screenshot selectors",
						cause: error,
					}),
			});

const releaseMaskStyle = (
	page: Page,
	styleId: string | null,
): Effect.Effect<void, never> =>
	styleId
		? Effect.tryPromise({
				try: () =>
					page.evaluate((id: string) => {
						const existing = document.getElementById(id);
						if (existing?.parentNode) {
							existing.parentNode.removeChild(existing);
						}
					}, styleId),
				catch: () => undefined,
			}).pipe(Effect.catchAll(() => Effect.void))
		: Effect.void;

export const captureScreenshots = (
	page: Page,
	viewport: ViewportConfig,
	routeDir: string,
	timestamp: string,
	cfg: CaptureScreenshotsConfig,
): Effect.Effect<ScreenshotPaths, CaptureError | FileSystemError> =>
	Effect.acquireUseRelease(
		acquireMaskStyle(page, cfg.screenshotHideSelectors),
		() =>
			Effect.gen(function* () {
				yield* Effect.tryPromise({
					try: () =>
						page.setViewportSize({
							width: viewport.width,
							height: viewport.height,
						}),
					catch: (error) =>
						new CaptureError({
							url: page.url(),
							message: "Failed to set viewport",
							cause: error,
						}),
				}).pipe(Effect.retry(captureRetryPolicy));

				yield* Effect.sleep(1000);

				const baseFilename = `${viewport.name}_${viewport.width}x${viewport.height}`;

				const pngLatestPath = path.join(
					routeDir,
					"screenshots",
					"png",
					`${baseFilename}_latest.png`,
				);
				const pngHistoryPath = path.join(
					routeDir,
					"screenshots",
					"png",
					"history",
					`${baseFilename}_${timestamp}.png`,
				);
				const webpLatestPath = path.join(
					routeDir,
					"screenshots",
					"webp",
					`${baseFilename}_latest.webp`,
				);
				const webpHistoryPath = path.join(
					routeDir,
					"screenshots",
					"webp",
					"history",
					`${baseFilename}_${timestamp}.webp`,
				);
				const jpgLatestPath = path.join(
					routeDir,
					"screenshots",
					"jpg",
					`${baseFilename}_latest.jpg`,
				);
				const jpgHistoryPath = path.join(
					routeDir,
					"screenshots",
					"jpg",
					"history",
					`${baseFilename}_${timestamp}.jpg`,
				);

				// Single PNG capture in memory; reused for WebP transcode.
				const pngBuffer = yield* Effect.tryPromise({
					try: () =>
						page.screenshot({
							fullPage: true,
							type: "png",
						}),
					catch: (error) =>
						new CaptureError({
							url: page.url(),
							message: "Failed to capture PNG",
							cause: error,
						}),
				}).pipe(Effect.retry(captureRetryPolicy));

				yield* Effect.tryPromise({
					try: () => fs.writeFile(pngLatestPath, pngBuffer),
					catch: (error) =>
						new FileSystemError({
							path: pngLatestPath,
							operation: "writeFile",
							cause: error,
						}),
				});
				yield* Effect.tryPromise({
					try: () => fs.copyFile(pngLatestPath, pngHistoryPath),
					catch: (error) =>
						new FileSystemError({
							path: pngHistoryPath,
							operation: "copyFile",
							cause: error,
						}),
				});

				// Real WebP via ffmpeg pipe (libwebp).
				const webpQuality = cfg.webpQuality ?? 90;
				yield* pipeImageThroughFfmpeg(
					cfg.ffmpegPath,
					pngBuffer,
					webpLatestPath,
					["-c:v", "libwebp", "-quality", String(webpQuality)],
				).pipe(Effect.retry(captureRetryPolicy));
				yield* Effect.tryPromise({
					try: () => fs.copyFile(webpLatestPath, webpHistoryPath),
					catch: (error) =>
						new FileSystemError({
							path: webpHistoryPath,
							operation: "copyFile",
							cause: error,
						}),
				});

				// Real JPEG via Playwright (already supported natively).
				const jpgQuality = cfg.jpgQuality ?? 85;
				yield* Effect.tryPromise({
					try: () =>
						page.screenshot({
							path: jpgLatestPath,
							fullPage: true,
							type: "jpeg",
							quality: jpgQuality,
						}),
					catch: (error) =>
						new CaptureError({
							url: page.url(),
							message: "Failed to capture JPEG",
							cause: error,
						}),
				}).pipe(Effect.retry(captureRetryPolicy));
				yield* Effect.tryPromise({
					try: () => fs.copyFile(jpgLatestPath, jpgHistoryPath),
					catch: (error) =>
						new FileSystemError({
							path: jpgHistoryPath,
							operation: "copyFile",
							cause: error,
						}),
				});

				console.log(
					`    ✓ Screenshots saved: ${baseFilename} (latest + history)`,
				);

				return new ScreenshotPaths({
					png: pngLatestPath,
					webp: webpLatestPath,
					jpg: jpgLatestPath,
				});
			}),
		(styleId) => releaseMaskStyle(page, styleId),
	);
