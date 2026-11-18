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
import { setTimeout as delay } from "node:timers/promises";
import {
	type Browser,
	type BrowserContext,
	chromium,
	type Frame,
	type Page,
	type Video,
} from "playwright";
import {
	type CaptureConfig,
	type CaptureConfigOverrides,
	createCaptureConfig,
	type ViewportConfig,
} from "./schemas.js";
import { exportShowcase } from "./showcase-export.js";
import {
	closeShowcaseContext,
	finalizeShowcaseArtifact,
} from "./showcase-lifecycle.js";
import { showPresentation, showSyncMarker } from "./showcase-presentation.js";
import { writeShowcaseReport } from "./showcase-report.js";
import {
	createShowcaseOriginGate,
	parseShowcaseFile,
	type ShowcaseFile,
	validateShowcase,
} from "./showcase-schema.js";
import { runShowcaseStep } from "./showcase-script.js";

export interface ShowcaseStepResult {
	index: number;
	kind: string;
	startMs: number;
	endMs: number;
	status: "complete" | "optional-failed" | "failed";
	error?: string;
}
export interface ShowcaseSceneResult {
	name: string;
	url: string;
	caption?: string;
	captionStartMs?: number;
	startMs: number;
	endMs: number;
	status: "running" | "complete" | "failed";
	executionStartMs: number;
	executionEndMs: number;
	steps: ShowcaseStepResult[];
	screenshot?: string;
	error?: string;
}
export interface ShowcaseReport {
	version: 1;
	name: string;
	title?: string;
	status: "running" | "complete" | "failed";
	outputDir: string;
	viewport: { name: string; width: number; height: number };
	startedAt: string;
	durationMs: number;
	executionDurationMs: number;
	trimStartMs?: number;
	scenes: ShowcaseSceneResult[];
	error?: string;
}
export interface ShowcaseOptions {
	readonly signal?: AbortSignal;
}

const message = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const recordViewport = async (
	seed: string,
	tour: ShowcaseFile,
	config: CaptureConfig,
	viewport: ViewportConfig,
	outputDir: string,
	signal: AbortSignal,
): Promise<ShowcaseReport> => {
	const executionStarted = performance.now();
	const recordAbort = new AbortController();
	signal = AbortSignal.any([signal, recordAbort.signal]);
	const report: ShowcaseReport = {
		version: 1,
		name: tour.name,
		...(tour.title ? { title: tour.title } : {}),
		status: "running",
		outputDir,
		viewport: {
			name: viewport.name,
			width: viewport.width,
			height: viewport.height,
		},
		startedAt: new Date().toISOString(),
		durationMs: 0,
		executionDurationMs: 0,
		scenes: [],
	};
	let browser: Browser | undefined;
	let context: BrowserContext | undefined;
	let video: Video | null = null;
	let capturePage: Page | undefined;
	let closeContext: Promise<void> | undefined;
	let cleanupFailure: Error | undefined;
	const close = () => {
		if (!context || !browser) return Promise.resolve();
		closeContext ??= closeShowcaseContext(context, browser).then((timedOut) => {
			if (timedOut)
				cleanupFailure = new Error(
					"Showcase recording context did not close within its cleanup budget; the browser was closed",
				);
		});
		return closeContext;
	};
	const abort = () => {
		void close();
	};
	const isAllowed = createShowcaseOriginGate(seed, config);
	const failNavigation = (error: Error) => {
		originFailure = error;
		recordAbort.abort(error);
	};
	let originFailure: Error | undefined;
	let current: ShowcaseSceneResult | undefined;
	let phase = "launch";
	let started = 0;
	const now = () =>
		started === 0 ? 0 : Math.round(performance.now() - started);
	let failure: unknown;
	signal.addEventListener("abort", abort, { once: true });
	try {
		signal.throwIfAborted();
		browser = await chromium.launch({
			headless: true,
			args: [...config.launchArgs],
			timeout: 30000,
		});
		signal.throwIfAborted();
		context = await browser.newContext({
			viewport: { width: viewport.width, height: viewport.height },
			recordVideo: {
				dir: path.join(outputDir, "raw"),
				size: { width: viewport.width, height: viewport.height },
			},
			colorScheme: config.colorScheme,
			ignoreHTTPSErrors: config.ignoreHttpsErrors,
			serviceWorkers: "block",
		});
		// Closing the context is the cancellation backstop for browser operations.
		signal.throwIfAborted();

		await context.route("**/*", async (route) => {
			try {
				const request = route.request();
				if (request.isNavigationRequest()) {
					let frame: Frame;
					try {
						frame = request.frame();
					} catch {
						await route.abort();
						failNavigation(
							new Error(
								"popup navigation is not supported in a single-page showcase",
							),
						);
						return;
					}
					if (capturePage && frame.page() !== capturePage) {
						await route.abort();
						failNavigation(
							new Error(
								"popup navigation is not supported in a single-page showcase",
							),
						);
						return;
					}
					if (
						frame.parentFrame() === null &&
						!isAllowed(new URL(request.url()))
					) {
						await route.abort();
						failNavigation(
							new Error(`navigation outside allowed origins: ${request.url()}`),
						);
						return;
					}
				}
				await route.continue();
			} catch (error) {
				if (!signal.aborted)
					failNavigation(
						new Error(`navigation interception failed: ${message(error)}`),
					);
			}
		});
		const page = await context.newPage();
		capturePage = page;
		video = page.video();
		context.on("page", (popup) => {
			failNavigation(
				new Error("popups are not supported in a single-page showcase"),
			);
			void popup.close().catch(() => {});
		});
		const session = await context.newCDPSession(page);
		const tree = await session.send("Page.getFrameTree");
		let mainFrameId = tree.frameTree.frame.id;
		session.on("Page.frameNavigated", (event) => {
			if (!event.frame.parentId) mainFrameId = event.frame.id;
		});
		session.on("Fetch.requestPaused", (event) => {
			void (async () => {
				if (
					event.frameId === mainFrameId &&
					!isAllowed(new URL(event.request.url))
				) {
					await session.send("Fetch.failRequest", {
						requestId: event.requestId,
						errorReason: "BlockedByClient",
					});
					failNavigation(
						new Error(
							`navigation outside allowed origins: ${event.request.url}`,
						),
					);
					return;
				}
				await session.send("Fetch.continueRequest", {
					requestId: event.requestId,
				});
			})().catch((error) => {
				if (!signal.aborted)
					failNavigation(
						new Error(`navigation interception failed: ${message(error)}`),
					);
			});
		});
		await session.send("Fetch.enable", {
			patterns: [{ resourceType: "Document", requestStage: "Request" }],
		});
		page.on("framenavigated", (frame) => {
			if (frame === page.mainFrame() && !isAllowed(new URL(frame.url())))
				failNavigation(
					new Error(`navigation outside allowed origins: ${frame.url()}`),
				);
		});
		page.setDefaultTimeout(5000);
		page.setDefaultNavigationTimeout(30000);
		for (const [index, scene] of tour.scenes.entries()) {
			signal.throwIfAborted();
			current = {
				name: scene.name,
				url: page.url(),
				...(scene.caption ? { caption: scene.caption } : {}),
				startMs: now(),
				endMs: now(),
				status: "running",
				executionStartMs: Math.round(performance.now() - executionStarted),
				executionEndMs: Math.round(performance.now() - executionStarted),
				steps: [],
			};
			report.scenes.push(current);
			const sceneAbort = new AbortController();
			const sceneSignal = AbortSignal.any([signal, sceneAbort.signal]);
			const timer = setTimeout(
				() =>
					sceneAbort.abort(
						new Error(
							`scene "${scene.name}" timed out during ${phase} after ${scene.timeoutMs}ms`,
						),
					),
				scene.timeoutMs,
			);
			const stop = () => {
				void close();
			};
			sceneSignal.addEventListener("abort", stop, { once: true });
			try {
				phase = "navigation";
				if (index === 0 || scene.url !== undefined)
					await page.goto(new URL(scene.url ?? seed, seed).toString(), {
						waitUntil: config.waitUntil,
						timeout: Math.min(scene.timeoutMs, 30000),
					});
				sceneSignal.throwIfAborted();
				if (originFailure) throw originFailure;
				phase = "readiness";
				if (scene.readySelector)
					await page
						.locator(scene.readySelector)
						.first()
						.waitFor({
							state: "visible",
							timeout: Math.min(scene.timeoutMs, 30000),
						});
				const caption = tour.captions ? (scene.caption ?? "") : "";
				await showPresentation(page, caption, tour.cursor);
				current.captionStartMs = now();
				if (index === 0) {
					phase = "synchronization";
					await showSyncMarker(page, "magenta");
					await delay(1500, undefined, { signal: sceneSignal });
					await showSyncMarker(page, "cyan");
					await delay(400, undefined, { signal: sceneSignal });
					await showSyncMarker(page, "magenta");
					await delay(400, undefined, { signal: sceneSignal });
					await showSyncMarker(page, null);
					started = performance.now();
					current.startMs = 0;
				}
				current.url = page.url();
				for (const [stepIndex, step] of scene.steps.entries()) {
					phase = `step ${stepIndex} (${step.kind})`;
					const result: ShowcaseStepResult = {
						index: stepIndex,
						kind: step.kind,
						startMs: now(),
						endMs: now(),
						status: "complete",
					};
					current.steps.push(result);
					try {
						const stepAbort = new AbortController();
						const stepSignal = AbortSignal.any([sceneSignal, stepAbort.signal]);
						const budget =
							step.timeoutMs ??
							(step.kind === "wait"
								? step.ms + 500
								: step.kind === "scroll"
									? step.durationMs + 1000
									: 5000);
						const stepTimer = setTimeout(
							() =>
								stepAbort.abort(
									new Error(
										`step ${stepIndex} (${step.kind}) exceeded ${budget}ms`,
									),
								),
							budget + 250,
						);
						const stopStep = () => {
							void close();
						};
						stepSignal.addEventListener("abort", stopStep, { once: true });
						try {
							await runShowcaseStep(page, step, isAllowed, stepSignal);
							stepSignal.throwIfAborted();
						} catch (error) {
							if (stepSignal.aborted) {
								sceneAbort.abort(stepSignal.reason);
								throw stepSignal.reason;
							}
							throw error;
						} finally {
							clearTimeout(stepTimer);
							stepSignal.removeEventListener("abort", stopStep);
						}
						sceneSignal.throwIfAborted();
						if (originFailure) throw originFailure;
					} catch (error) {
						const cause = sceneSignal.aborted
							? sceneSignal.reason
							: (originFailure ?? error);
						result.error = message(cause).replace(
							/^.*?state "showcase" failed at step 0 \(.*?\): /s,
							"",
						);
						result.status =
							step.optional && !sceneSignal.aborted && !originFailure
								? "optional-failed"
								: "failed";
						if (result.status === "failed")
							throw new Error(result.error, { cause });
					} finally {
						result.endMs = now();
					}
					await showPresentation(page, caption, tour.cursor);
					if (step.settleMs) {
						phase = `settlement after step ${stepIndex} (${step.kind})`;
						await delay(step.settleMs, undefined, { signal: sceneSignal });
					}
				}
				phase = "hold";
				await delay(scene.holdMs, undefined, { signal: sceneSignal });
				phase = "screenshot";
				const screenshot = path.join("scenes", `${scene.name}.png`);
				await page.screenshot({
					path: path.join(outputDir, screenshot),
					fullPage: false,
					timeout: 10000,
				});
				sceneSignal.throwIfAborted();
				if (originFailure) throw originFailure;
				current.screenshot = screenshot;
				current.url = page.url();
				current.endMs = now();
				current.status = "complete";
				current.executionEndMs = Math.round(
					performance.now() - executionStarted,
				);
			} catch (error) {
				const cause = sceneSignal.aborted
					? sceneSignal.reason
					: (originFailure ?? error);
				current.status = "failed";
				current.endMs = now();
				current.executionEndMs = Math.round(
					performance.now() - executionStarted,
				);
				current.error = `scene "${scene.name}" failed during ${phase}: ${message(cause)}`;
				throw new Error(current.error, { cause });
			} finally {
				clearTimeout(timer);
				sceneSignal.removeEventListener("abort", stop);
			}
		}
		report.durationMs = now();
	} catch (error) {
		failure = error;
	} finally {
		await close();
		failure ??= cleanupFailure;
		if (video) {
			try {
				await fs.rename(
					await finalizeShowcaseArtifact(video.path()),
					path.join(outputDir, "source.webm"),
				);
				await fs.rm(path.join(outputDir, "raw"), {
					recursive: true,
					force: true,
				});
			} catch (error) {
				failure ??= error;
			}
		}
		await browser?.close().catch(() => {});
		signal.removeEventListener("abort", abort);
	}
	try {
		if (failure) throw failure;
		signal.throwIfAborted();
		phase = "export";
		const first = report.scenes[0]?.screenshot;
		if (first)
			await fs.copyFile(
				path.join(outputDir, first),
				path.join(outputDir, "poster.png"),
			);
		const exported = await exportShowcase({
			ffmpegPath: config.ffmpegPath,
			sourcePath: path.join(outputDir, "source.webm"),
			outputPath: path.join(outputDir, "showcase.mp4"),
			durationMs: report.durationMs,
			signal,
		});
		signal.throwIfAborted();
		report.trimStartMs = exported.trimStartMs;
		report.status = "complete";
	} catch (error) {
		await fs.rm(path.join(outputDir, "showcase.mp4"), { force: true });
		report.status = "failed";
		report.error = message(error);
		report.durationMs = report.durationMs || now();
		failure = error;
	}
	report.executionDurationMs = Math.round(performance.now() - executionStarted);
	try {
		await writeShowcaseReport(report);
	} catch (error) {
		await fs.rm(path.join(outputDir, "showcase.mp4"), { force: true });
		throw error;
	}
	if (failure)
		throw new Error(report.error ?? message(failure), { cause: failure });
	return report;
};

/** Record each explicitly requested viewport once. Existing output runs are never overwritten. */
export const captureShowcase = async (
	seedUrl: string,
	definition: unknown,
	overrides: CaptureConfigOverrides = {},
	options: ShowcaseOptions = {},
): Promise<ShowcaseReport[]> => {
	const tour = parseShowcaseFile(JSON.stringify(definition), "showcase");
	const config = createCaptureConfig({
		...overrides,
		viewports: overrides.viewports ?? [
			{ name: "desktop", width: 1920, height: 1080 },
		],
	});
	if (config.states.length > 0)
		throw new Error("showcase is exclusive; states cannot be combined with it");
	validateShowcase(tour, seedUrl, config);
	options.signal?.throwIfAborted();
	const root = path.resolve(config.outputDir, "showcases", tour.name);
	await fs.mkdir(path.dirname(root), { recursive: true });
	try {
		await fs.mkdir(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new Error(
				`showcase output already exists: ${root}; choose a new --output-dir or showcase name`,
			);
		throw error;
	}
	const timeout = new AbortController();
	const timer = setTimeout(
		() =>
			timeout.abort(
				new Error(
					`showcase "${tour.name}" exceeded its ${tour.timeoutMs}ms run budget`,
				),
			),
		tour.timeoutMs,
	);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeout.signal])
		: timeout.signal;
	const reports: ShowcaseReport[] = [];
	try {
		for (const viewport of config.viewports) {
			signal.throwIfAborted();
			const outputDir = path.join(root, viewport.name);
			await fs.mkdir(path.join(outputDir, "scenes"), { recursive: true });
			reports.push(
				await recordViewport(
					seedUrl,
					tour,
					config,
					viewport,
					outputDir,
					signal,
				),
			);
		}
		return reports;
	} finally {
		clearTimeout(timer);
	}
};
