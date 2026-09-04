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
import {
	BrowserError,
	CaptureError,
	FileSystemError,
	StateCaptureError,
	type StateDefinitionError,
} from "./errors.js";
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
	getCaptureDir,
	getRouteName,
	navigationRetryPolicy,
	normalizeUrl,
	type QueueTask,
	type RouteTask,
	ShutdownSignal,
	type StateTask,
	stateResultKey,
} from "./shared.js";
import {
	createScriptedStateRunner,
	INITIAL_STEP_PROGRESS,
} from "./state-script.js";
import { type ResolvedState, validateStates } from "./states.js";
import { captureVideoForViewport } from "./video.js";
import { performWarmupScroll } from "./warmup.js";

/**
 * Baseline Chromium switches. These keep the browser usable inside containers
 * and CI sandboxes; anything beyond them comes from `config.launchArgs`.
 */
const DEFAULT_LAUNCH_ARGS = [
	"--no-sandbox",
	"--disable-setuid-sandbox",
	"--disable-dev-shm-usage",
] as const;

export class CaptureConfigTag extends Context.Tag("CaptureConfig")<
	CaptureConfigTag,
	CaptureConfig
>() {}

/** A one-line, report-ready rendering of any failure this service can raise. */
const formatCaptureFailure = (error: unknown): string => {
	if (error instanceof FileSystemError) {
		return `${error.operation} failed for ${error.path}`;
	}
	if (error instanceof Error && error.message) return error.message;
	return String(error);
};

/**
 * Creates one capture unit's directory tree. `captureDir` is an opaque prefix:
 * a crawled route's own directory, or `<route>/states/<name>/` for a scripted
 * state.
 */
const createDirectories = (
	captureDir: string,
	captureVideo: boolean,
): Effect.Effect<void, FileSystemError> =>
	Effect.tryPromise({
		try: async () => {
			await fs.mkdir(path.join(captureDir, "screenshots", "png", "history"), {
				recursive: true,
			});
			await fs.mkdir(path.join(captureDir, "screenshots", "webp", "history"), {
				recursive: true,
			});
			await fs.mkdir(path.join(captureDir, "screenshots", "jpg", "history"), {
				recursive: true,
			});
			if (captureVideo) {
				await fs.mkdir(path.join(captureDir, "videos", "high-quality"), {
					recursive: true,
				});
				await fs.mkdir(path.join(captureDir, "videos", "medium-quality"), {
					recursive: true,
				});
				await fs.mkdir(path.join(captureDir, "videos", "low-quality"), {
					recursive: true,
				});
			}
		},
		catch: (error) =>
			new FileSystemError({
				path: captureDir,
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
						// Caller-supplied switches come last so they win on conflict.
						args: [...DEFAULT_LAUNCH_ARGS, ...cfg.launchArgs],
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

			// Link discovery opens menus so links become *discoverable*; the state
			// runner performs a named script so a state becomes *capturable*. Two
			// page-manipulation toolkits from one config, neither owning the other.
			const { runStateScript, checkPrecondition } = createScriptedStateRunner(
				{},
			);

			/**
			 * What a scripted state changes about a capture: where it lands, which
			 * viewports it is valid at, whether video is recorded, and how the video
			 * context reaches the same state the stills show.
			 */
			interface StateCaptureContext {
				readonly name: string;
				readonly viewports: ReadonlyArray<ViewportConfig>;
				readonly captureVideo: boolean;
				readonly prepare: (page: Page) => Effect.Effect<void, CaptureError>;
			}

			const capturePage = (
				page: Page,
				url: string,
				stateContext?: StateCaptureContext,
			): Effect.Effect<CaptureResult, CaptureError | FileSystemError> =>
				Effect.gen(function* () {
					const route = getRouteName(url);
					const captureDir = getCaptureDir(
						cfg.outputDir,
						url,
						stateContext?.name,
					);
					const viewports = stateContext?.viewports ?? cfg.viewports;
					const wantVideo = stateContext
						? stateContext.captureVideo
						: cfg.captureVideo;

					yield* createDirectories(captureDir, wantVideo);
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
						viewports.map((viewport: ViewportConfig) =>
							Effect.gen(function* () {
								console.log(
									`  Capturing ${viewport.name} (${viewport.width}x${viewport.height})`,
								);
								const screenshots = yield* captureScreenshots(
									page,
									viewport,
									captureDir,
									timestamp,
									{
										ffmpegPath: cfg.ffmpegPath,
										screenshotHideSelectors: cfg.screenshotHideSelectors,
									},
								);

								const videos =
									wantVideo && browser
										? Option.some(
												yield* captureVideoForViewport(
													browser,
													page,
													viewport,
													captureDir,
													timestamp,
													{
														waitTime: cfg.waitTime,
														ffmpegPath: cfg.ffmpegPath,
														videoOptions: cfg.videoOptions,
														colorScheme: cfg.colorScheme,
														...(stateContext
															? { prepare: stateContext.prepare }
															: {}),
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
						state: stateContext?.name,
						stateStatus: stateContext ? "captured" : undefined,
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

			/**
			 * A scripted state is a capture leaf: it never feeds the crawl frontier,
			 * and it runs in its **own** browser context rather than on the worker's
			 * long-lived page.
			 *
			 * `page.goto` clears neither cookies nor `localStorage`, so reusing the
			 * worker page would let state N inherit state N-1's client storage and
			 * make the determinism guarantee aspirational rather than true. Roughly
			 * 100ms against a multi-second capture buys real isolation.
			 *
			 * Every runtime failure is recorded as a `CaptureResult` and swallowed
			 * here, so the worker pool cannot be disturbed by a bad script.
			 */
			const processStateTask = (
				task: StateTask,
				resolved: ResolvedState,
				results: Map<string, CaptureResult>,
				workerLabel: string,
			): Effect.Effect<void> =>
				Effect.gen(function* () {
					const { state, steps } = resolved;
					const budgetMs = state.timeoutMs ?? cfg.stateTimeout;
					console.log(
						`\n[Worker ${workerLabel}] [State ${state.name}] Capturing: ${task.url}`,
					);

					const progress = yield* Ref.make(INITIAL_STEP_PROGRESS);

					// The script runs once and the viewport loop resizes afterwards, so
					// a state whose UI unmounts below a breakpoint must say which
					// viewports it is valid at rather than silently shooting the boot
					// view and recording it as success.
					const stateViewports = state.viewports
						? cfg.viewports.filter((viewport) =>
								state.viewports?.includes(viewport.name),
							)
						: cfg.viewports;

					const usesRequests = steps.some((step) => step.kind === "request");
					const stateCaptureVideo =
						cfg.captureVideo && (!usesRequests || state.allowVideoReplay);
					if (cfg.captureVideo && !stateCaptureVideo) {
						console.log(
							`  ! Skipping video for "${state.name}": recording replays the script in a second context, so a non-idempotent request step would seed twice and the video would disagree with the stills (set allowVideoReplay to override)`,
						);
					}

					const stateFailure = (message: string, cause: unknown) =>
						new StateCaptureError({
							state: state.name,
							stepIndex: -1,
							stepKind: "state",
							target: task.url,
							message: `state "${state.name}" failed: ${message}`,
							cause,
						});

					const prepare = (videoPage: Page) =>
						runStateScript(videoPage, state.name, steps, progress).pipe(
							Effect.mapError(
								(error) =>
									new CaptureError({
										url: task.url,
										message: error.message,
										cause: error,
									}),
							),
						);

					const runInContext = Effect.acquireUseRelease(
						Effect.gen(function* () {
							if (!browser) {
								return yield* Effect.fail(
									stateFailure("browser not initialized", null),
								);
							}
							const browserRef = browser;
							const context = yield* Effect.tryPromise({
								try: () =>
									browserRef.newContext({ colorScheme: cfg.colorScheme }),
								catch: (error) =>
									stateFailure("failed to create a browser context", error),
							});
							const page = yield* Effect.tryPromise({
								try: () => context.newPage(),
								catch: (error) =>
									stateFailure("failed to create a page", error),
							});
							return { context, page };
						}),
						({ page }) =>
							Effect.gen(function* () {
								yield* Effect.tryPromise({
									try: () =>
										page
											.goto(task.url, {
												waitUntil: "networkidle",
												timeout: 30000,
											})
											.then(() => undefined),
									catch: (error) =>
										stateFailure(`failed to navigate to ${task.url}`, error),
								}).pipe(Effect.retry(navigationRetryPolicy));

								if (state.precondition !== undefined) {
									const present = yield* checkPrecondition(
										page,
										state.precondition,
									);
									if (!present) {
										console.log(
											`  - State "${state.name}" skipped: precondition "${state.precondition}" is not present on ${task.url}`,
										);
										results.set(
											task.resultKey,
											new CaptureResult({
												url: task.url,
												route: getRouteName(task.url),
												state: state.name,
												stateStatus: "skipped",
												screenshots: {},
												timestamp: Date.now(),
											}),
										);
										return;
									}
								}

								yield* runStateScript(page, state.name, steps, progress);

								const result = yield* capturePage(page, task.url, {
									name: state.name,
									viewports: stateViewports,
									captureVideo: stateCaptureVideo,
									prepare,
								}).pipe(
									Effect.mapError((error) =>
										stateFailure(formatCaptureFailure(error), error),
									),
								);

								results.set(task.resultKey, result);
							}),
						({ context }) =>
							Effect.tryPromise({
								try: () => context.close(),
								catch: () => undefined,
							}).pipe(Effect.catchAll(() => Effect.void)),
					);

					yield* runInContext.pipe(
						Effect.timeout(budgetMs),
						Effect.catchTag("TimeoutException", () =>
							Effect.gen(function* () {
								const at = yield* Ref.get(progress);
								return yield* Effect.fail(
									new StateCaptureError({
										state: state.name,
										stepIndex: at.index,
										stepKind: at.kind,
										target: at.target,
										message:
											at.index < 0
												? `state "${state.name}" timed out after ${budgetMs}ms before its first step completed`
												: `state "${state.name}" timed out after ${budgetMs}ms on step ${at.index} (${at.kind} "${at.target}")`,
										cause: null,
									}),
								);
							}),
						),
						Effect.catchAll((error) =>
							Effect.gen(function* () {
								const message = formatCaptureFailure(error);
								console.error(`[Worker ${workerLabel}] ${message}`);
								// An empty state directory is a visible artefact of a state
								// that was attempted and did not reach its target — the
								// opposite of a state that silently never existed.
								yield* createDirectories(
									getCaptureDir(cfg.outputDir, task.url, state.name),
									false,
								).pipe(Effect.catchAll(() => Effect.void));
								results.set(
									task.resultKey,
									new CaptureResult({
										url: task.url,
										route: getRouteName(task.url),
										state: state.name,
										stateStatus: "failed",
										failedStepIndex:
											error instanceof StateCaptureError ? error.stepIndex : -1,
										screenshots: {},
										error: message,
										timestamp: Date.now(),
									}),
								);
							}),
						),
					);
				});

			const captureWebsite = (
				url: string,
			): Effect.Effect<
				Map<string, CaptureResult>,
				BrowserError | CaptureError | FileSystemError | StateDefinitionError
			> =>
				Effect.gen(function* () {
					console.log("Starting UI capture for:", url);
					const urlObj = new URL(url);
					hostFilters.hydrate(urlObj.hostname, cfg.allowedHosts);

					// Authoring errors abort before Chromium ever launches: no amount of
					// retrying makes a typo'd `extends` resolve.
					const resolvedStates = yield* validateStates({
						states: cfg.states,
						seedUrl: url,
						hostMatchesFilters: (hostname) =>
							hostFilters.hostMatchesFilters(hostname, cfg.includeSubdomains),
						allowStateRequests: cfg.allowStateRequests,
						viewportNames: cfg.viewports.map((viewport) => viewport.name),
						captureRoutes: cfg.captureRoutes,
					});

					const seedingStates = Array.from(resolvedStates.values()).some(
						(entry) => entry.steps.some((step) => step.kind === "request"),
					);
					if (seedingStates && cfg.routeConcurrency > 1) {
						console.warn(
							"  ! Some states seed through request steps and workers run in parallel: a fresh browser context cannot un-seed a server. Use idempotent or per-state-keyed seeds, or --concurrency 1.",
						);
					}

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

								const stateTasks: StateTask[] = Array.from(
									resolvedStates.values(),
									(entry) => {
										const stateUrl = new URL(entry.url ?? url, url).toString();
										return {
											type: "state" as const,
											url: stateUrl,
											stateName: entry.state.name,
											normalizedUrl: normalizeUrl(stateUrl),
											resultKey: stateResultKey(stateUrl, entry.state.name),
										};
									},
								);

								// Every state is seeded before a worker starts taking, so the
								// queue has to be able to hold them all or `Queue.offer`
								// deadlocks against an empty pool.
								const queueCapacity = Math.max(
									32,
									cfg.routeConcurrency * 8,
									stateTasks.length + 1,
								);
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
											if (task.type === "state") {
												const resolved = resolvedStates.get(task.stateName);
												yield* (
													resolved
														? processStateTask(
																task,
																resolved,
																results,
																`#${workerId}`,
															)
														: Effect.void
												).pipe(Effect.ensuring(markTaskComplete()));
												continue;
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
												try: () =>
													browserRef.newContext({
														colorScheme: cfg.colorScheme,
													}),
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

								// States are seeded alongside the seed route, before any
								// worker starts, so their ordering never depends on discovery
								// order and a crawl that dies early cannot silently drop them.
								if (cfg.captureRoutes) {
									yield* scheduleRoute(url, 0);
								}
								yield* Effect.forEach(
									stateTasks,
									(stateTask) =>
										Effect.gen(function* () {
											yield* Ref.update(pendingTasks, (count) => count + 1);
											yield* Queue.offer(taskQueue, stateTask);
										}),
									{ discard: true },
								);

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
