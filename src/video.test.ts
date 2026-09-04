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
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Deferred, Effect, Exit, Fiber } from "effect";
import type { Browser, Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureError } from "./errors.js";
import { ViewportConfig } from "./schemas.js";
import { type CaptureVideoConfig, captureVideoForViewport } from "./video.js";

const VIEWPORT = new ViewportConfig({
	name: "desktop",
	width: 1280,
	height: 720,
});

/** The URL a capture started at — the entry point of the route or state. */
const ENTRY_URL = "https://app.example.com/console";

interface FakeBrowserOptions {
	/** Path returned by `page.video().path()`; `null` models "no video". */
	readonly videoPath?: string | null;
	readonly newContextRejects?: Error;
	readonly gotoRejects?: Error;
}

interface FakeBrowser {
	readonly browser: Browser;
	/** Every `context.close()` this run performed, in order. */
	readonly closed: string[];
	readonly created: string[];
	readonly visited: string[];
	readonly closedPages: number[];
}

const makeBrowser = (options: FakeBrowserOptions = {}): FakeBrowser => {
	const closed: string[] = [];
	const created: string[] = [];
	const visited: string[] = [];
	const closedPages: number[] = [];
	let contextCount = 0;

	const browser = {
		newContext: async () => {
			if (options.newContextRejects) throw options.newContextRejects;
			const id = `context-${contextCount++}`;
			created.push(id);
			const context = {
				newPage: async () => {
					const page = {
						goto: async (url: string) => {
							visited.push(url);
							if (options.gotoRejects) throw options.gotoRejects;
							return null;
						},
						evaluate: async () => undefined,
						close: async () => {
							closedPages.push(created.length);
						},
						video: () =>
							options.videoPath === null
								? undefined
								: {
										path: async () =>
											options.videoPath ?? "/tmp/unused-video.webm",
									},
					};
					return page as unknown as Page;
				},
				close: async () => {
					closed.push(id);
				},
			};
			return context;
		},
	} as unknown as Browser;

	return { browser, closed, created, visited, closedPages };
};

const config = (
	overrides: Partial<CaptureVideoConfig> = {},
): CaptureVideoConfig => ({
	waitTime: 0,
	// Absent on purpose: every transcode fails fast with ENOENT, which is the
	// already-tolerated path (logged, master still returned).
	ffmpegPath: path.join(os.tmpdir(), "ui-capture-no-such-ffmpeg"),
	videoOptions: { duration: 0, interactions: false },
	colorScheme: "light",
	startUrl: ENTRY_URL,
	...overrides,
});

describe("captureVideoForViewport", () => {
	let dir: string;
	let log: ReturnType<typeof vi.spyOn>;
	let error: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-capture-video-"));
		await fs.mkdir(path.join(dir, "videos", "high-quality"), {
			recursive: true,
		});
		log = vi.spyOn(console, "log").mockImplementation(() => {});
		error = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(async () => {
		log.mockRestore();
		error.mockRestore();
		await fs.rm(dir, { recursive: true, force: true });
	});

	const run = (
		fake: FakeBrowser,
		cfg: Partial<CaptureVideoConfig> = {},
	): Effect.Effect<unknown, unknown> =>
		captureVideoForViewport(
			fake.browser,
			VIEWPORT,
			dir,
			"2026-01-01T00-00-00-000Z",
			config(cfg),
		);

	describe("recording context lifetime", () => {
		it("closes the recording context on the happy path", async () => {
			const raw = path.join(dir, "raw.webm");
			await fs.writeFile(raw, "video");
			const fake = makeBrowser({ videoPath: raw });

			const exit = await Effect.runPromiseExit(run(fake));

			expect(Exit.isSuccess(exit)).toBe(true);
			expect(fake.closed).toEqual(fake.created);
		});

		it("closes the recording context when the replay fails", async () => {
			const raw = path.join(dir, "raw.webm");
			await fs.writeFile(raw, "video");
			const fake = makeBrowser({ videoPath: raw });

			const exit = await Effect.runPromiseExit(
				run(fake, {
					prepare: () =>
						Effect.fail(
							new CaptureError({
								url: ENTRY_URL,
								message: "state script blew up during replay",
								cause: null,
							}),
						),
				}),
			);

			expect(Exit.isFailure(exit)).toBe(true);
			expect(fake.created).toHaveLength(1);
			expect(fake.closed).toEqual(fake.created);
		});

		it("closes the recording context when navigation fails", async () => {
			const fake = makeBrowser({
				videoPath: path.join(dir, "raw.webm"),
				gotoRejects: new Error("net::ERR_CONNECTION_REFUSED"),
			});

			const exit = await Effect.runPromiseExit(run(fake));

			expect(Exit.isFailure(exit)).toBe(true);
			expect(fake.closed).toEqual(fake.created);
		});

		it("closes the recording context when the fiber is interrupted", async () => {
			const fake = makeBrowser({ videoPath: path.join(dir, "raw.webm") });
			const replaying = await Effect.runPromise(Deferred.make<void>());

			const fiber = Effect.runFork(
				run(fake, {
					prepare: () =>
						Deferred.succeed(replaying, undefined).pipe(
							Effect.zipRight(Effect.never),
						),
				}),
			);

			// Interrupt only once the replay is actually in flight, so the
			// interruption lands inside the acquired context rather than before it.
			await Effect.runPromise(Deferred.await(replaying));
			const exit = await Effect.runPromise(Fiber.interrupt(fiber));

			expect(Exit.isInterrupted(exit)).toBe(true);
			expect(fake.created).toHaveLength(1);
			expect(fake.closed).toEqual(fake.created);
		});

		it("closes the recording context when the state budget times out", async () => {
			const fake = makeBrowser({ videoPath: path.join(dir, "raw.webm") });

			// The real interruption path: `Effect.timeout` on the state budget in
			// service.ts cancels the fiber mid-replay.
			const exit = await Effect.runPromiseExit(
				run(fake, { prepare: () => Effect.never }).pipe(Effect.timeout(25)),
			);

			expect(Exit.isFailure(exit)).toBe(true);
			expect(fake.created).toHaveLength(1);
			expect(fake.closed).toEqual(fake.created);
		});
	});

	describe("replay entry point", () => {
		it("navigates to the URL the capture began at, not the post-script URL", async () => {
			const raw = path.join(dir, "raw.webm");
			await fs.writeFile(raw, "video");
			const fake = makeBrowser({ videoPath: raw });

			// A state script that navigates leaves the captured page on a detail
			// view; the video must still replay from the state's entry point.
			await Effect.runPromiseExit(
				run(fake, {
					startUrl: ENTRY_URL,
					prepare: () => Effect.void,
				}),
			);

			expect(fake.visited).toEqual([ENTRY_URL]);
			expect(fake.visited).not.toContain(
				"https://app.example.com/console/drone/42",
			);
		});
	});

	describe("master recording", () => {
		it("renames the raw recording into the high-quality directory", async () => {
			const raw = path.join(dir, "raw.webm");
			await fs.writeFile(raw, "video");
			const fake = makeBrowser({ videoPath: raw });

			const exit = await Effect.runPromiseExit(run(fake));
			const master = path.join(
				dir,
				"videos",
				"high-quality",
				`desktop_1280x720_2026-01-01T00-00-00-000Z.webm`,
			);

			expect(Exit.isSuccess(exit)).toBe(true);
			expect(await fs.readFile(master, "utf8")).toBe("video");
			// The rename can only succeed once the context has been closed and the
			// recording flushed, so release must run before it.
			expect(fake.closed).toHaveLength(1);
		});

		it("fails, and still closes the context, when no video was recorded", async () => {
			const fake = makeBrowser({ videoPath: null });

			const exit = await Effect.runPromiseExit(run(fake));

			expect(Exit.isFailure(exit)).toBe(true);
			expect(fake.closed).toEqual(fake.created);
		});
	});
});
