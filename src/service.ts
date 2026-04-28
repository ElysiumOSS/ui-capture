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
import { Context, Effect, Layer, Option, Queue, Ref } from "effect";
import { type Browser, chromium, type Page } from "playwright";
import { BrowserError, CaptureError, FileSystemError } from "./errors.js";
import { createLinkDiscoveryTools } from "./link-discovery.js";
import { generateReports } from "./report.js";
import {
	CaptureConfig,
	type CaptureConfigOverrides,
	CaptureResult,
	createCaptureConfig,
	type ScreenshotPaths,
	type VideoQualityPaths,
	type ViewportConfig,
} from "./schemas.js";
import { captureScreenshots } from "./screenshot.js";
import {
	createHostFilterState,
	getRouteName,
	navigationRetryPolicy,
	normalizeUrl,
	type QueueTask,
	type RouteTask,
	ShutdownSignal,
} from "./shared.js";
import { captureVideoForViewport } from "./video.js";
import { performWarmupScroll } from "./warmup.js";

export class CaptureConfigTag extends Context.Tag("CaptureConfig")<
	CaptureConfigTag,
	CaptureConfig
>() {}

const createDirectories = (
	routeDir: string,
	captureVideo: boolean,
): Effect.Effect<void, FileSystemError> =>
	Effect.tryPromise({
		try: async () => {
			await fs.mkdir(path.join(routeDir, "screenshots", "png", "history"), {
				recursive: true,
			});
			await fs.mkdir(path.join(routeDir, "screenshots", "webp", "history"), {
				recursive: true,
			});
			await fs.mkdir(path.join(routeDir, "screenshots", "jpg", "history"), {
				recursive: true,
			});
			if (captureVideo) {
				await fs.mkdir(path.join(routeDir, "videos", "high-quality"), {
					recursive: true,
				});
				await fs.mkdir(path.join(routeDir, "videos", "medium-quality"), {
					recursive: true,
				});
				await fs.mkdir(path.join(routeDir, "videos", "low-quality"), {
					recursive: true,
				});
			}
		},
		catch: (error) =>
			new FileSystemError({
				path: routeDir,
				operation: "mkdir",
				cause: error,
			}),
	});

export class UICaptureService extends Effect.Service<UICaptureService>()(
	"UICaptureService",
	{
		effect: Effect.gen(function* () {
			const cfg = yield* CaptureConfigTag;

			let browser: Browser | null = null;
			const processedRoutes = new Set<string>();
			const hostFilters = createHostFilterState();

			const initialize = Effect.tryPromise({
				try: async () => {
					await fs.mkdir(cfg.outputDir, { recursive: true });
					browser = await chromium.launch({
						headless: true,
						args: [
							"--no-sandbox",
							"--disable-setuid-sandbox",
							"--disable-dev-shm-usage",
						],
					});
					console.log("✓ Browser initialized");
					return browser;
				},
				catch: (error) =>
					new BrowserError({
						message: "Failed to initialize browser",
						cause: error,
					}),
			});

			const cleanup = Effect.tryPromise({
				try: async () => {
					if (browser) {
						await browser.close();
						browser = null;
					}
					processedRoutes.clear();
					console.log("✓ Browser cleanup complete");
				},
				catch: (error) =>
					new BrowserError({
						message: "Failed to cleanup browser",
						cause: error,
					}),
			});

			const { prepareForLinkDiscovery, extractLinks } =
				createLinkDiscoveryTools({
					hostMatchesFilters: (hostname) =>
						hostFilters.hostMatchesFilters(hostname, cfg.includeSubdomains),
					menuInteractionSelectors: cfg.menuInteractionSelectors,
				});

			const capturePage = (
				page: Page,
				url: string,
			): Effect.Effect<CaptureResult, CaptureError | FileSystemError> =>
				Effect.gen(function* () {
					const route = getRouteName(url);
					const routeDir = path.join(cfg.outputDir, route);

					yield* createDirectories(routeDir, cfg.captureVideo);
					yield* Effect.tryPromise({
						try: () => page.waitForLoadState("networkidle"),
						catch: (error) =>
							new CaptureError({
								url,
								message: "Failed to wait for page load",
								cause: error,
							}),
					});
					yield* Effect.sleep(cfg.waitTime);

					if (cfg.warmupScroll) {
						yield* performWarmupScroll(page, url).pipe(
							Effect.catchAll((error) => {
								console.warn(
									`  ! Warm-up scroll failed (continuing): ${error.message}`,
								);
								return Effect.void;
							}),
						);
						yield* Effect.tryPromise({
							try: () =>
								page.waitForLoadState("networkidle", { timeout: 10000 }),
							catch: () => undefined,
						}).pipe(Effect.catchAll(() => Effect.void));
					}

					const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

					const screenshotResults = yield* Effect.all(
						cfg.viewports.map((viewport: ViewportConfig) =>
							Effect.gen(function* () {
								console.log(
									`  Capturing ${viewport.name} (${viewport.width}x${viewport.height})`,
								);
								const screenshots = yield* captureScreenshots(
									page,
									viewport,
									routeDir,
									timestamp,
									{
										ffmpegPath: cfg.ffmpegPath,
										screenshotHideSelectors: cfg.screenshotHideSelectors,
									},
								);

								const videos =
									cfg.captureVideo && browser
										? Option.some(
												yield* captureVideoForViewport(
													browser,
													page,
													viewport,
													routeDir,
													timestamp,
													{
														waitTime: cfg.waitTime,
														ffmpegPath: cfg.ffmpegPath,
														videoOptions: cfg.videoOptions,
													},
												),
											)
										: Option.none();

								return [viewport.name, { screenshots, videos }] as const;
							}),
						),
						{ concurrency: 1 },
					);

					const screenshots: Record<string, ScreenshotPaths> = {};
					const videos: Record<string, VideoQualityPaths> = {};

					for (const [name, data] of screenshotResults) {
						screenshots[name] = data.screenshots;
						if (Option.isSome(data.videos)) {
							videos[name] = data.videos.value;
						}
					}

					return new CaptureResult({
						url,
						route,
						screenshots,
						videos: Object.keys(videos).length > 0 ? videos : undefined,
						timestamp: Date.now(),
					});
				});

			const processRouteTask = (
				page: Page,
				task: RouteTask,
				results: Map<string, CaptureResult>,
				scheduleNext: (
					url: string,
					depth: number,
				) => Effect.Effect<void, never>,
				workerLabel: string,
			): Effect.Effect<void, CaptureError | FileSystemError> =>
				Effect.gen(function* () {
					const indent = "  ".repeat(task.depth);
					console.log(
						`\n${indent}[Worker ${workerLabel}] [Depth ${task.depth}] Capturing: ${task.url}`,
					);

					yield* Effect.tryPromise({
						try: () =>
							page.goto(task.url, { waitUntil: "networkidle", timeout: 30000 }),
						catch: (error) =>
							new CaptureError({
								url: task.url,
								message: "Failed to navigate",
								cause: error,
							}),
					}).pipe(Effect.retry(navigationRetryPolicy));

					yield* prepareForLinkDiscovery(page, task.url);

					const discoveredLinks =
						task.depth < cfg.maxDepth ? yield* extractLinks(page) : [];

					console.log(
						`${indent}  Found ${discoveredLinks.length} internal links`,
					);

					const result = yield* capturePage(page, task.url);
					results.set(task.normalizedUrl, result);

					if (discoveredLinks.length > 0) {
						const schedulingConcurrency = Math.max(
							1,
							Math.min(cfg.routeConcurrency, discoveredLinks.length),
						);
						yield* Effect.forEach(
							discoveredLinks,
							(link) => scheduleNext(link, task.depth + 1),
							{ concurrency: schedulingConcurrency },
						);
					}
				});

			const captureWebsite = (
				url: string,
			): Effect.Effect<
				Map<string, CaptureResult>,
				BrowserError | CaptureError | FileSystemError
			> =>
				Effect.gen(function* () {
					console.log("Starting UI capture for:", url);
					const urlObj = new URL(url);
					hostFilters.hydrate(urlObj.hostname, cfg.allowedHosts);

					const results = new Map<string, CaptureResult>();

					yield* Effect.acquireUseRelease(
						initialize,
						() =>
							Effect.gen(function* () {
								if (!browser) {
									return yield* Effect.fail(
										new CaptureError({
											url,
											message: "Browser not initialized",
											cause: null,
										}),
									);
								}

								const queueCapacity = Math.max(32, cfg.routeConcurrency * 8);
								const taskQueue =
									yield* Queue.bounded<QueueTask>(queueCapacity);
								const pendingTasks = yield* Ref.make(0);
								const shutdownNotified = yield* Ref.make(false);

								const signalShutdown = (): Effect.Effect<void, never> =>
									Effect.gen(function* () {
										const already = yield* Ref.get(shutdownNotified);
										if (already) return;
										yield* Ref.set(shutdownNotified, true);
										for (let i = 0; i < cfg.routeConcurrency; i++) {
											yield* Queue.offer(taskQueue, ShutdownSignal);
										}
									});

								const scheduleRoute = (
									routeUrl: string,
									depth: number,
								): Effect.Effect<void, never> =>
									Effect.gen(function* () {
										if (depth > cfg.maxDepth) return;
										if (yield* Ref.get(shutdownNotified)) return;

										let hostname: string;
										try {
											hostname = new URL(routeUrl).hostname;
										} catch {
											return;
										}

										if (
											!hostFilters.hostMatchesFilters(
												hostname,
												cfg.includeSubdomains,
											)
										) {
											return;
										}

										const normalizedUrlStr = normalizeUrl(routeUrl);

										const taskOption = yield* Effect.sync(() => {
											if (processedRoutes.has(normalizedUrlStr)) {
												return Option.none<RouteTask>();
											}
											processedRoutes.add(normalizedUrlStr);
											return Option.some<RouteTask>({
												type: "route",
												url: routeUrl,
												depth,
												normalizedUrl: normalizedUrlStr,
											});
										});

										if (Option.isSome(taskOption)) {
											yield* Ref.update(pendingTasks, (count) => count + 1);
											yield* Queue.offer(taskQueue, taskOption.value);
										}
									});

								const markTaskComplete = (): Effect.Effect<void, never> =>
									Effect.gen(function* () {
										const remaining = yield* Ref.updateAndGet(
											pendingTasks,
											(count) => Math.max(0, count - 1),
										);
										if (remaining === 0) {
											yield* signalShutdown();
										}
									});

								const workerLoop = (
									page: Page,
									workerId: number,
								): Effect.Effect<void, CaptureError | FileSystemError> =>
									Effect.gen(function* () {
										while (true) {
											const task = yield* Queue.take(taskQueue);
											if (task.type === "shutdown") {
												return yield* Effect.void;
											}
											yield* processRouteTask(
												page,
												task,
												results,
												scheduleRoute,
												`#${workerId}`,
											).pipe(
												Effect.catchAll((error) => {
													console.error(
														`[Worker ${workerId}] Failed to capture ${task.url}:`,
														error,
													);
													return Effect.void;
												}),
												Effect.ensuring(markTaskComplete()),
											);
										}
									});

								const createWorker = (
									workerId: number,
								): Effect.Effect<void, CaptureError | FileSystemError> =>
									Effect.acquireUseRelease(
										Effect.gen(function* () {
											if (!browser) {
												return yield* Effect.fail(
													new CaptureError({
														url,
														message: "Browser not initialized",
														cause: null,
													}),
												);
											}
											const browserRef = browser;
											const context = yield* Effect.tryPromise({
												try: () => browserRef.newContext(),
												catch: (error) =>
													new CaptureError({
														url,
														message: `Worker ${workerId}: Failed to create context`,
														cause: error,
													}),
											});
											const page = yield* Effect.tryPromise({
												try: () => context.newPage(),
												catch: (error) =>
													new CaptureError({
														url,
														message: `Worker ${workerId}: Failed to create page`,
														cause: error,
													}),
											});
											console.log(`✓ Worker ${workerId} ready`);
											return { context, page };
										}),
										({ page }) => workerLoop(page, workerId),
										({ context }) =>
											Effect.tryPromise({
												try: () => context.close(),
												catch: () => undefined,
											}).pipe(Effect.catchAll(() => Effect.void)),
									);

								yield* scheduleRoute(url, 0);
								const initialPending = yield* Ref.get(pendingTasks);
								if (initialPending === 0) {
									yield* signalShutdown();
								}

								const workers = Array.from(
									{ length: cfg.routeConcurrency },
									(_, idx) => createWorker(idx + 1),
								);

								yield* Effect.all(workers, {
									concurrency: cfg.routeConcurrency,
								});
								yield* Queue.shutdown(taskQueue);

								yield* generateReports(cfg.outputDir, cfg.viewports, results);
								console.log(
									`\n✓ Capture completed! Results saved to: ${cfg.outputDir}`,
								);
							}),
						() => cleanup.pipe(Effect.orDie),
					);

					return results;
				});

			return { captureWebsite } as const;
		}),
	},
) {}

export const CaptureConfigLive = (
	config?: CaptureConfig | CaptureConfigOverrides,
) =>
	Layer.succeed(
		CaptureConfigTag,
		config instanceof CaptureConfig ? config : createCaptureConfig(config),
	);
