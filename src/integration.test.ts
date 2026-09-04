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
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CaptureConfigLive, UICaptureService } from "./service.js";
import { filterStates, parseStatesFile } from "./states.js";

// Real browser+ffmpeg integration. Off by default; flip RUN_INTEGRATION=1 to opt in.
const RUN = process.env.RUN_INTEGRATION === "1";

describe.skipIf(!RUN)(
	"integration: captureWebsite against a fixture site",
	() => {
		let server: http.Server;
		let baseUrl: string;
		let outDir: string;

		beforeAll(async () => {
			server = http.createServer((req, res) => {
				const route = req.url ?? "/";
				const links = [
					'<a href="/">Home</a>',
					'<a href="/about">About</a>',
					'<a href="/contact">Contact</a>',
				].join(" | ");
				const body =
					`<!doctype html><html><head><title>fixture ${route}</title></head>` +
					`<body><h1>route ${route}</h1><nav>${links}</nav>` +
					`<main><p>content for ${route}</p></main></body></html>`;
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(body);
			});
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", () => resolve()),
			);
			const port = (server.address() as AddressInfo).port;
			baseUrl = `http://127.0.0.1:${port}/`;
			outDir = await fs.mkdtemp(path.join(os.tmpdir(), "uic-int-"));
		});

		afterAll(async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
		});

		it("crawls reachable routes, writes screenshots and a report", async () => {
			const program = Effect.gen(function* () {
				const svc = yield* UICaptureService;
				return yield* svc.captureWebsite(baseUrl);
			}).pipe(
				Effect.provide(UICaptureService.Default),
				Effect.provide(
					CaptureConfigLive({
						outputDir: outDir,
						maxDepth: 1,
						routeConcurrency: 1,
						waitTime: 100,
						warmupScroll: false,
						viewports: [{ name: "desktop", width: 1280, height: 720 }],
					}),
				),
			);

			const results = await Effect.runPromise(program);

			// root + at least about + contact (asset filter never engages here, none of
			// the fixture URLs end in an asset extension).
			expect(results.size).toBeGreaterThanOrEqual(3);

			const report = JSON.parse(
				await fs.readFile(path.join(outDir, "capture-report.json"), "utf8"),
			);
			expect(report.totalRoutes).toBeGreaterThanOrEqual(3);
			expect(report.failedCaptures).toBe(0);
			expect(report.successfulCaptures).toBe(report.totalRoutes);

			const md = await fs.readFile(path.join(outDir, "REPORT.md"), "utf8");
			expect(md).toMatch(/^# UI Capture Report/);
			expect(md).toContain("Total Routes:");

			// All three image formats land for the only viewport we configured.
			const rootDir = path.join(outDir, "root", "screenshots");
			for (const fmt of ["png", "webp", "jpg"] as const) {
				const file = path.join(rootDir, fmt, `desktop_1280x720_latest.${fmt}`);
				const stat = await fs.stat(file);
				expect(stat.size).toBeGreaterThan(0);
			}
		}, 60_000);
	},
);

/**
 * Scripted states against a real browser and a real single-route fixture.
 *
 * The motivating failure this feature exists to kill is a crawler pointed at a
 * one-URL app: it screenshots the boot view and reports the site fully
 * covered. Everything below is asserted against files on disk and the report
 * the run actually wrote, never by inspecting the implementation.
 */
describe.skipIf(!RUN)("integration: scripted states", () => {
	let server: http.Server;
	let baseUrl: string;
	let tmpRoot: string;
	let seedCount = 0;
	// How many times the seed endpoint was actually reached. `seedCount` is the
	// number of rows it makes the page render; this is the number of POSTs, and
	// it is the only way to tell "the ancestor was replayed once to reach the
	// child" from "the ancestor was captured as a state of its own too".
	let seedHits = 0;
	// `/once` answers the first request and 500s afterwards. It is the only
	// asymmetry available between a capture and its video replay, which by
	// design run the same script against the same URL.
	let onceCount = 0;
	// A second origin on the same host, and the count of requests that reached
	// it. The runtime `request` gate is the only thing standing between a
	// script that navigates here and a POST the states file never declared.
	let otherServer: http.Server;
	let otherBaseUrl: string;
	let otherHits = 0;

	const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>fixture console</title>
<style>
  body { font-family: sans-serif; margin: 0; padding: 24px; background: #ffffff; color: #111111; }
  #panel { display: none; }
  #panel.open { display: block; }
  #panel-inner { width: 640px; height: 420px; background: #c1121f; color: #ffffff; font-size: 48px; }
  .seeded-row { padding: 10px; margin: 6px 0; background: #eeeeee; }
</style></head>
<body>
  <h1>fixture console</h1>
  <button id="reveal">Reveal panel</button>
  <button id="stash">Stash</button>
  <section id="panel"><div id="panel-inner">PANEL</div></section>
  <div id="rows">{ROWS}</div>
  <script>
    document.body.dataset.storage = localStorage.getItem('uicStash') ? 'dirty' : 'empty';
    document.getElementById('reveal').addEventListener('click', function () {
      document.getElementById('panel').classList.add('open');
    });
    document.getElementById('stash').addEventListener('click', function () {
      localStorage.setItem('uicStash', '1');
      document.body.dataset.storage = 'dirty';
    });
    document.body.setAttribute('data-app-ready', '');
  </script>
</body></html>`;

	const baseConfig = (outputDir: string) => ({
		outputDir,
		maxDepth: 0,
		routeConcurrency: 1,
		waitTime: 100,
		warmupScroll: false,
		stateTimeout: 25_000,
		viewports: [{ name: "desktop", width: 1280, height: 720 }],
	});

	const writeStatesFile = async (
		dir: string,
		states: ReadonlyArray<Record<string, unknown>>,
	) => {
		const file = path.join(dir, "ui-capture.states.json");
		await fs.writeFile(file, JSON.stringify({ version: 1, states }, null, 2));
		// Round-trip through the real parser, exactly as the CLI does.
		return parseStatesFile(await fs.readFile(file, "utf8"), file);
	};

	const capture = (
		url: string,
		overrides: Parameters<typeof CaptureConfigLive>[0],
	) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const svc = yield* UICaptureService;
				return yield* svc.captureWebsite(url);
			}).pipe(
				Effect.provide(UICaptureService.Default),
				Effect.provide(CaptureConfigLive(overrides)),
			),
		);

	const readReport = async (outputDir: string) =>
		JSON.parse(
			await fs.readFile(path.join(outputDir, "capture-report.json"), "utf8"),
		);

	const shot = (outputDir: string, ...segments: string[]) =>
		path.join(
			outputDir,
			...segments,
			"screenshots",
			"png",
			"desktop_1280x720_latest.png",
		);

	const outDir = async (name: string) => {
		const dir = path.join(tmpRoot, name);
		await fs.mkdir(dir, { recursive: true });
		return dir;
	};

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (url.pathname === "/once") {
				onceCount += 1;
				if (onceCount > 1) {
					res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
					res.end("<!doctype html><html><body><h1>gone</h1></body></html>");
					return;
				}
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(PAGE_HTML.replace("{ROWS}", ""));
				return;
			}
			if (url.pathname === "/hop") {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(
					`<!doctype html><html><body data-app-ready><a id="hop" href="${otherBaseUrl}">go</a></body></html>`,
				);
				return;
			}
			if (url.pathname === "/api/seed") {
				if (req.method !== "POST") {
					res.writeHead(405).end();
					return;
				}
				seedCount = 3;
				seedHits += 1;
				res.writeHead(201, { "content-type": "application/json" });
				res.end('{"ok":true}');
				return;
			}
			const rows = Array.from(
				{ length: seedCount },
				(_, i) => `<div class="seeded-row">drone ${i}</div>`,
			).join("");
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(PAGE_HTML.replace("{ROWS}", rows));
		});
		otherServer = http.createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (url.pathname === "/api/pwn") {
				otherHits += 1;
				res.writeHead(200, { "content-type": "application/json" });
				res.end('{"ok":true}');
				return;
			}
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(
				"<!doctype html><html><body data-app-ready><h1>elsewhere</h1></body></html>",
			);
		});
		await new Promise<void>((resolve) =>
			otherServer.listen(0, "127.0.0.1", () => resolve()),
		);
		otherBaseUrl = `http://127.0.0.1:${(otherServer.address() as AddressInfo).port}/`;

		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", () => resolve()),
		);
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "uic-states-"));
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await new Promise<void>((resolve) => otherServer.close(() => resolve()));
		await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
	});

	it("captures a revealed state as its own image set, and a broken state fails alone", async () => {
		const dir = await outDir("states");
		const states = await writeStatesFile(dir, [
			{
				name: "revealed",
				description: "the panel the crawler can never reach",
				steps: [
					{ kind: "waitFor", selector: "[data-app-ready]" },
					{ kind: "click", selector: "#reveal", settleMs: 100 },
					{ kind: "waitFor", selector: "#panel-inner", state: "visible" },
				],
			},
			{
				name: "broken",
				steps: [
					{ kind: "waitFor", selector: "[data-app-ready]" },
					{ kind: "waitFor", selector: "#never-appears", timeoutMs: 500 },
				],
			},
			{
				name: "chained",
				extends: "revealed",
				steps: [{ kind: "waitFor", selector: "#panel", state: "visible" }],
			},
		]);

		const results = await capture(baseUrl, { ...baseConfig(dir), states });

		// One crawled route plus three states, all present in the results map.
		expect(results.size).toBe(4);
		const byState = new Map(
			Array.from(results.values())
				.filter((r) => r.state)
				.map((r) => [r.state as string, r]),
		);
		expect([...byState.keys()].sort()).toEqual([
			"broken",
			"chained",
			"revealed",
		]);

		// The boot view and the revealed state are two different images.
		const bootShot = shot(dir, "root");
		const revealedShot = shot(dir, "root", "states", "revealed");
		const chainedShot = shot(dir, "root", "states", "chained");
		for (const file of [bootShot, revealedShot, chainedShot]) {
			expect((await fs.stat(file)).size).toBeGreaterThan(0);
		}
		const bootBytes = await fs.readFile(bootShot);
		const revealedBytes = await fs.readFile(revealedShot);
		expect(bootBytes.equals(revealedBytes)).toBe(false);
		// A chained state replays its parent, so it reaches the same panel.
		expect((await fs.readFile(chainedShot)).equals(bootBytes)).toBe(false);

		// All three image formats land for a state, exactly as for a route.
		for (const fmt of ["png", "webp", "jpg"] as const) {
			const file = path.join(
				dir,
				"root",
				"states",
				"revealed",
				"screenshots",
				fmt,
				`desktop_1280x720_latest.${fmt}`,
			);
			expect((await fs.stat(file)).size).toBeGreaterThan(0);
		}

		// The broken state failed by itself and the run carried on.
		const report = await readReport(dir);
		expect(report.totalRoutes).toBe(1);
		expect(report.totalStates).toBe(3);
		expect(report.failedCaptures).toBe(1);
		expect(report.successfulCaptures).toBe(3);
		expect(report.skippedStates).toBe(0);

		const broken = report.results.find(
			(r: { state?: string }) => r.state === "broken",
		);
		expect(broken.stateStatus).toBe("failed");
		expect(broken.failedStepIndex).toBe(1);
		expect(broken.error).toContain("#never-appears");
		expect(broken.screenshots).toEqual([]);

		// An empty state directory is a visible artefact of a state that was
		// attempted and did not reach its target.
		const brokenDir = path.join(dir, "root", "states", "broken");
		expect((await fs.stat(brokenDir)).isDirectory()).toBe(true);
		expect(
			await fs.readdir(path.join(brokenDir, "screenshots", "png")),
		).toEqual(["history"]);

		const md = await fs.readFile(path.join(dir, "REPORT.md"), "utf8");
		expect(md).toContain("## Scripted States");
		expect(md).toContain("| broken |");
		expect(md).toContain("✗ failed");
		expect(md).toContain("### root — revealed");
	}, 180_000);

	it("gives each state a clean page: no client storage carries between them", async () => {
		const dir = await outDir("determinism");
		// `stash` writes localStorage; `fresh` runs afterwards on the same worker
		// and asserts the storage marker is still empty. If states shared a page
		// or a context, `fresh` would see "dirty" and fail.
		const states = await writeStatesFile(dir, [
			{
				name: "stash",
				steps: [
					{ kind: "waitFor", selector: "[data-app-ready]" },
					{ kind: "click", selector: "#stash" },
					{ kind: "waitFor", selector: "body[data-storage='dirty']" },
				],
			},
			{
				name: "fresh",
				steps: [
					{ kind: "waitFor", selector: "[data-app-ready]" },
					{
						kind: "waitFor",
						selector: "body[data-storage='empty']",
						timeoutMs: 3000,
					},
				],
			},
			{
				name: "replayed",
				extends: "stash",
				steps: [
					{
						kind: "waitFor",
						selector: "body[data-storage='dirty']",
						timeoutMs: 3000,
					},
				],
			},
		]);

		const results = await capture(baseUrl, {
			...baseConfig(dir),
			captureRoutes: false,
			routeConcurrency: 1,
			states,
		});

		const report = await readReport(dir);
		const statuses = Object.fromEntries(
			report.results.map((r: { state: string; stateStatus: string }) => [
				r.state,
				r.stateStatus,
			]),
		);
		// `fresh` proves isolation; `replayed` proves an explicit chain still
		// reaches the parent's state by replaying its steps.
		expect(statuses).toEqual({
			stash: "captured",
			fresh: "captured",
			replayed: "captured",
		});
		expect(report.failedCaptures).toBe(0);
		expect(report.totalRoutes).toBe(0);
		expect(report.totalStates).toBe(3);

		// The isolation assertion is only meaningful if `stash` actually ran
		// first, so pin the ordering rather than trusting it.
		const at = (name: string) => {
			const found = Array.from(results.values()).find((r) => r.state === name);
			if (!found) throw new Error(`no result for state ${name}`);
			return found.timestamp;
		};
		expect(at("stash")).toBeLessThanOrEqual(at("fresh"));
	}, 180_000);

	it("seeds through the app's own API when request steps are allowed", async () => {
		const dir = await outDir("seeded");
		seedCount = 0;
		const states = await writeStatesFile(dir, [
			{
				name: "fleet",
				steps: [
					{ kind: "waitFor", selector: "[data-app-ready]" },
					{
						kind: "request",
						method: "POST",
						path: "/api/seed",
						json: { count: 3 },
						expectStatus: 201,
					},
					{ kind: "reload" },
					{
						kind: "waitFor",
						selector: ".seeded-row",
						minCount: 3,
						timeoutMs: 5000,
					},
				],
			},
		]);

		await capture(baseUrl, {
			...baseConfig(dir),
			captureRoutes: false,
			allowStateRequests: true,
			states,
		});

		const report = await readReport(dir);
		expect(report.results[0].stateStatus).toBe("captured");
		expect(report.failedCaptures).toBe(0);
		expect(
			(await fs.stat(shot(dir, "root", "states", "fleet"))).size,
		).toBeGreaterThan(0);
	}, 180_000);

	it("refuses a request step before launching a browser when it is not allowed", async () => {
		const dir = await outDir("ungated");
		const states = await writeStatesFile(dir, [
			{
				name: "fleet",
				steps: [{ kind: "request", method: "POST", path: "/api/seed" }],
			},
		]);

		await expect(
			capture(baseUrl, { ...baseConfig(dir), states }),
		).rejects.toThrow(/allow-state-requests/);
		// Nothing was written, because nothing was launched.
		await expect(fs.readdir(dir)).resolves.toEqual(["ui-capture.states.json"]);
	}, 60_000);

	it("re-judges a request against the origin the script actually navigated to", async () => {
		// The bypass: the pre-launch pass validates `/api/pwn` against the
		// state's configured URL, which is on the seed origin and passes. The
		// script then navigates to a different origin, where the same relative
		// path resolves somewhere the file never declared. The gate that
		// decides therefore has to run at the moment the step resolves.
		const dir = await outDir("gate-runtime");
		otherHits = 0;
		const states = await writeStatesFile(dir, [
			{
				name: "hop",
				url: "/hop",
				steps: [
					{ kind: "click", selector: "#hop", settleMs: 300 },
					{ kind: "waitFor", selector: "h1" },
					{ kind: "request", method: "POST", path: "/api/pwn" },
				],
			},
		]);

		await capture(baseUrl, {
			...baseConfig(dir),
			captureRoutes: false,
			allowStateRequests: true,
			states,
		});

		const report = await readReport(dir);
		expect(report.results[0].stateStatus).toBe("failed");
		expect(report.results[0].error).toContain("outside the allowed origins");
		// The point of the whole exercise: the other origin was never touched.
		expect(otherHits).toBe(0);
	}, 120_000);

	it("fails a state whose precondition cannot be evaluated, rather than skipping it", async () => {
		// A typo'd selector answering "not present here" is the worst outcome
		// available: a green run that captured nothing, and nothing in the
		// report to notice.
		const dir = await outDir("precondition-broken");
		const states = await writeStatesFile(dir, [
			{
				name: "typo",
				precondition: "##panel",
				preconditionTimeoutMs: 1500,
				steps: [{ kind: "click", selector: "#reveal" }],
			},
		]);

		await capture(baseUrl, {
			...baseConfig(dir),
			captureRoutes: false,
			states,
		});

		const report = await readReport(dir);
		expect(report.skippedStates).toBe(0);
		expect(report.failedCaptures).toBe(1);
		const typo = report.results.find(
			(r: { state?: string }) => r.state === "typo",
		);
		expect(typo.stateStatus).toBe("failed");
		expect(typo.error).toContain("precondition");
	}, 120_000);

	it("records an unmet precondition as skipped, not failed", async () => {
		const dir = await outDir("precondition");
		const states = await writeStatesFile(dir, [
			{
				name: "absent",
				precondition: "#does-not-exist",
				steps: [{ kind: "click", selector: "#reveal" }],
			},
			{
				name: "present",
				precondition: "#reveal",
				steps: [
					{ kind: "click", selector: "#reveal" },
					{ kind: "waitFor", selector: "#panel-inner" },
				],
			},
		]);

		await capture(baseUrl, {
			...baseConfig(dir),
			captureRoutes: false,
			// The default probe budget is 10s; an absent precondition pays it in
			// full, and this test has two states to get through.
			preconditionTimeout: 1500,
			states,
		});

		const report = await readReport(dir);
		expect(report.skippedStates).toBe(1);
		expect(report.failedCaptures).toBe(0);
		expect(report.successfulCaptures).toBe(1);
		const absent = report.results.find(
			(r: { state?: string }) => r.state === "absent",
		);
		expect(absent.stateStatus).toBe("skipped");
		expect(absent.error).toBeUndefined();
		const md = await fs.readFile(path.join(dir, "REPORT.md"), "utf8");
		expect(md).toContain("– skipped");
	}, 120_000);

	it("spends the state budget on reaching the state, not on capturing it", async () => {
		// The budget used to wrap the capture too, which made it unsatisfiable:
		// with --video on, no default could cover navigation + script + a
		// screenshot per viewport + a recording per viewport, so every state
		// timed out. Here the whole run deliberately outlives the budget.
		const dir = await outDir("budget-scope");
		const states = await writeStatesFile(dir, [
			{
				name: "revealed",
				steps: [
					{ kind: "waitFor", selector: "[data-app-ready]" },
					{ kind: "click", selector: "#reveal", settleMs: 100 },
					{ kind: "waitFor", selector: "#panel-inner", state: "visible" },
				],
			},
		]);

		const budgetMs = 2500;
		const startedAt = Date.now();
		await capture(baseUrl, {
			...baseConfig(dir),
			captureRoutes: false,
			captureVideo: true,
			videoOptions: { duration: 4000, interactions: false },
			stateTimeout: budgetMs,
			states,
		});
		const elapsed = Date.now() - startedAt;

		const report = await readReport(dir);
		expect(report.results[0].stateStatus).toBe("captured");
		expect(report.failedCaptures).toBe(0);
		expect(report.results[0].hasVideo).toBe(true);
		// The proof that the budget no longer covers capture: the state was
		// captured even though the work took longer than the budget allows.
		expect(elapsed).toBeGreaterThan(budgetMs);
		expect(
			(await fs.stat(shot(dir, "root", "states", "revealed"))).size,
		).toBeGreaterThan(0);
	}, 180_000);

	it("keeps the screenshots when the video replay fails", async () => {
		// The stills are on disk before recording starts. Losing the video must
		// not discard them or turn a capture that produced files into a failure
		// that reports none.
		const dir = await outDir("video-partial");
		onceCount = 0;
		const states = await writeStatesFile(dir, [
			{
				name: "replay-loses",
				url: "/once",
				steps: [
					{ kind: "waitFor", selector: "[data-app-ready]", timeoutMs: 2000 },
					{ kind: "click", selector: "#reveal", settleMs: 100 },
				],
			},
		]);

		await capture(baseUrl, {
			...baseConfig(dir),
			captureRoutes: false,
			captureVideo: true,
			videoOptions: { duration: 1000, interactions: false },
			states,
		});

		const report = await readReport(dir);
		const result = report.results[0];
		expect(result.stateStatus).toBe("captured");
		expect(result.screenshots).toEqual(["desktop"]);
		expect(result.hasVideo).toBe(false);
		expect(result.videoErrors).toHaveLength(1);
		expect(result.videoErrors[0]).toContain("desktop");
		expect(report.failedCaptures).toBe(0);
		expect(report.successfulCaptures).toBe(1);
		expect(
			(await fs.stat(shot(dir, "once", "states", "replay-loses"))).size,
		).toBeGreaterThan(0);
		const md = await fs.readFile(path.join(dir, "REPORT.md"), "utf8");
		expect(md).toContain("**Video capture failed:**");
	}, 180_000);

	it("names what it was doing when the budget expired, not the last step it started", async () => {
		const dir = await outDir("budget-phase");
		const states = await writeStatesFile(dir, [
			{
				name: "no-time",
				timeoutMs: 1,
				steps: [{ kind: "waitFor", selector: "[data-app-ready]" }],
			},
		]);

		await capture(baseUrl, {
			...baseConfig(dir),
			captureRoutes: false,
			states,
		});

		const report = await readReport(dir);
		const result = report.results[0];
		expect(result.stateStatus).toBe("failed");
		expect(result.error).toContain("timed out after 1ms");
		expect(result.error).toContain("while loading");
		// A step index would point the reader at a step that never ran.
		expect(result.failedStepIndex).toBe(-1);
	}, 60_000);

	it("names the step that was actually running when the budget expired", async () => {
		// The other half of the same claim: when a step *is* what is running,
		// the message and `failedStepIndex` name that step — not the state, and
		// not a step that already succeeded.
		const dir = await outDir("budget-in-step");
		const states = await writeStatesFile(dir, [
			{
				name: "hangs-on-step-1",
				// Comfortably past a local navigation, and well short of the step's
				// own 60 s timeout, so the *state* budget is what expires.
				timeoutMs: 2500,
				steps: [
					{ kind: "waitFor", selector: "[data-app-ready]" },
					{ kind: "waitFor", selector: "#never-appears", timeoutMs: 60_000 },
				],
			},
		]);

		await capture(baseUrl, {
			...baseConfig(dir),
			captureRoutes: false,
			states,
		});

		const report = await readReport(dir);
		const result = report.results[0];
		expect(result.stateStatus).toBe("failed");
		expect(result.error).toContain("timed out after 2500ms");
		expect(result.error).toContain('on step 1 (waitFor "#never-appears")');
		expect(result.failedStepIndex).toBe(1);
	}, 120_000);

	it("restricts a state to the viewports it is valid at", async () => {
		const dir = await outDir("viewports");
		const states = await writeStatesFile(dir, [
			{
				name: "desktop-only",
				viewports: ["desktop"],
				steps: [{ kind: "waitFor", selector: "[data-app-ready]" }],
			},
		]);

		await capture(baseUrl, {
			...baseConfig(dir),
			captureRoutes: false,
			viewports: [
				{ name: "desktop", width: 1280, height: 720 },
				{ name: "mobile", width: 390, height: 844 },
			],
			states,
		});

		const pngDir = path.join(
			dir,
			"root",
			"states",
			"desktop-only",
			"screenshots",
			"png",
		);
		const files = (await fs.readdir(pngDir)).sort();
		expect(files).toEqual(["desktop_1280x720_latest.png", "history"]);
	}, 120_000);

	/** The two states a `--state-filter` run has to tell apart. */
	const seedChain = [
		{
			name: "seeded",
			// The opt-out lives on the ancestor, and the `request` step it opts
			// out of is inherited with it — the pair a filtered run must not split.
			allowVideoReplay: true,
			steps: [
				{ kind: "waitFor", selector: "[data-app-ready]" },
				{
					kind: "request",
					method: "POST",
					path: "/api/seed",
					expectStatus: 201,
				},
				{ kind: "reload", waitUntil: "networkidle" },
			],
		},
		{
			name: "seeded-rows",
			extends: "seeded",
			steps: [{ kind: "waitFor", selector: ".seeded-row", minCount: 3 }],
		},
	] as const;

	it("captures only the named state, replaying its ancestor rather than capturing it", async () => {
		const dir = await outDir("filter");
		seedCount = 0;
		seedHits = 0;
		const parsed = await writeStatesFile(dir, [...seedChain]);
		// Exactly what the CLI does for `--state-filter seeded-rows`.
		const selected = filterStates(parsed, ["seeded-rows"]);

		await capture(baseUrl, {
			...baseConfig(dir),
			captureRoutes: false,
			allowStateRequests: true,
			states: selected,
		});

		const report = await readReport(dir);
		expect(report.results.map((r: { state: string }) => r.state)).toEqual([
			"seeded-rows",
		]);
		expect(report.results[0].stateStatus).toBe("captured");
		// The ancestor is resolution input, not a capture target: its seed ran
		// once, to reach the named state. Capturing it too would POST twice.
		expect(seedHits).toBe(1);
		await expect(
			fs.stat(path.join(dir, "root", "states", "seeded")),
		).rejects.toThrow();
		expect(
			(await fs.stat(shot(dir, "root", "states", "seeded-rows"))).size,
		).toBeGreaterThan(0);
	}, 120_000);

	it("keeps the ancestor's allowVideoReplay when the chain is flattened by the filter", async () => {
		// Flattening used to carry the ancestor's `request` step but not its
		// opt-out, so the same file recorded video unfiltered and silently
		// dropped it under --state-filter.
		const dir = await outDir("filter-video");
		seedCount = 0;
		seedHits = 0;
		const parsed = await writeStatesFile(dir, [...seedChain]);
		const selected = filterStates(parsed, ["seeded-rows"]);

		await capture(baseUrl, {
			...baseConfig(dir),
			captureRoutes: false,
			allowStateRequests: true,
			captureVideo: true,
			videoOptions: { duration: 1000, interactions: false },
			states: selected,
		});

		const report = await readReport(dir);
		expect(report.results[0].stateStatus).toBe("captured");
		expect(report.results[0].hasVideo).toBe(true);
		// Once for the stills, once for the replay the opt-out permits.
		expect(seedHits).toBe(2);
	}, 180_000);

	it("leaves no browser context alive when a state fails or is interrupted", async () => {
		const dir = await outDir("contexts");
		const states = await writeStatesFile(dir, [
			{
				name: "ok",
				steps: [{ kind: "waitFor", selector: "[data-app-ready]" }],
			},
			{
				name: "script-fails",
				steps: [
					{ kind: "waitFor", selector: "#never-appears", timeoutMs: 500 },
				],
			},
			{
				// A budget this small interrupts the fiber mid-navigation, which is
				// the interruption path — not merely an error return.
				name: "budget-interrupted",
				timeoutMs: 1,
				steps: [{ kind: "waitFor", selector: "[data-app-ready]" }],
			},
		]);

		// Counted at the last moment it can still be non-zero: after the run has
		// finished with the browser, before the browser is torn down.
		const liveAtClose: number[] = [];
		const realLaunch = chromium.launch;
		chromium.launch = async (options) => {
			const browser = await realLaunch.call(chromium, options);
			const realClose = browser.close.bind(browser);
			browser.close = async (closeOptions?: { reason?: string }) => {
				liveAtClose.push(browser.contexts().length);
				await realClose(closeOptions);
			};
			return browser;
		};

		try {
			await capture(baseUrl, {
				...baseConfig(dir),
				captureRoutes: false,
				states,
			});
		} finally {
			chromium.launch = realLaunch;
		}

		const report = await readReport(dir);
		expect(
			report.results.map((r: { stateStatus: string }) => r.stateStatus).sort(),
		).toEqual(["captured", "failed", "failed"]);
		// The assertion that matters is this one, not the absence of an error:
		// every context the run opened — worker, state and video — was closed
		// before the browser was.
		expect(liveAtClose).toEqual([0]);
	}, 120_000);

	it("captures a state under the shipped defaults with video, without timing out", async () => {
		// No stateTimeout, no viewport list, no waitTime, no videoOptions: the
		// configuration a user gets from `--video` alone, which is exactly the
		// one that used to make every state time out.
		const dir = await outDir("defaults-video");
		const states = await writeStatesFile(dir, [
			{
				name: "revealed",
				steps: [
					{ kind: "waitFor", selector: "[data-app-ready]" },
					{ kind: "click", selector: "#reveal", settleMs: 100 },
					{ kind: "waitFor", selector: "#panel-inner", state: "visible" },
				],
			},
		]);

		await capture(baseUrl, {
			outputDir: dir,
			captureVideo: true,
			captureRoutes: false,
			states,
		});

		const report = await readReport(dir);
		const result = report.results[0];
		expect(result.stateStatus).toBe("captured");
		expect(result.error).toBeUndefined();
		expect(result.videoErrors).toBeUndefined();
		// All three default viewports, each with its own recording.
		expect([...result.screenshots].sort()).toEqual([
			"desktop",
			"mobile",
			"tablet",
		]);
		expect(result.hasVideo).toBe(true);
		expect(report.failedCaptures).toBe(0);
	}, 300_000);

	it("aborts on an authoring error before the browser launches", async () => {
		const dir = await outDir("authoring");
		const states = await writeStatesFile(dir, [
			{ name: "child", extends: "missing-parent", steps: [] },
		]);
		await expect(
			capture(baseUrl, { ...baseConfig(dir), states }),
		).rejects.toThrow(/extends unknown state/);
	}, 60_000);
});

/**
 * The feature is additive, and this is the proof: the same fixture crawled
 * with no states file at all produces the pre-feature tree and the
 * pre-feature report numbers.
 */
describe.skipIf(!RUN)("integration: backwards compatibility", () => {
	let server: http.Server;
	let baseUrl: string;
	let outputDir: string;

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			const route = req.url ?? "/";
			const links = ['<a href="/">Home</a>', '<a href="/about">About</a>'].join(
				" | ",
			);
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(
				`<!doctype html><html><head><title>bc ${route}</title></head>` +
					`<body><h1>route ${route}</h1><nav>${links}</nav></body></html>`,
			);
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", () => resolve()),
		);
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
		outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "uic-bc-"));
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
	});

	it("produces the pre-feature output tree and report when no states are given", async () => {
		const results = await Effect.runPromise(
			Effect.gen(function* () {
				const svc = yield* UICaptureService;
				return yield* svc.captureWebsite(baseUrl);
			}).pipe(
				Effect.provide(UICaptureService.Default),
				Effect.provide(
					CaptureConfigLive({
						outputDir,
						maxDepth: 1,
						routeConcurrency: 1,
						waitTime: 100,
						warmupScroll: false,
						viewports: [{ name: "desktop", width: 1280, height: 720 }],
					}),
				),
			),
		);

		const files: string[] = [];
		const walk = async (dir: string) => {
			for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) await walk(full);
				else files.push(path.relative(outputDir, full).replace(/\\/g, "/"));
			}
		};
		await walk(outputDir);

		// Timestamps differ per run; the shape is what has to be identical.
		const shape = files
			.map((file) =>
				file.replace(/_\d{4}-\d{2}-\d{2}T[\d-]+Z\.(png|webp|jpg)$/, "_<ts>.$1"),
			)
			.sort();

		expect(shape).toEqual([
			"REPORT.md",
			"about/screenshots/jpg/desktop_1280x720_latest.jpg",
			"about/screenshots/jpg/history/desktop_1280x720_<ts>.jpg",
			"about/screenshots/png/desktop_1280x720_latest.png",
			"about/screenshots/png/history/desktop_1280x720_<ts>.png",
			"about/screenshots/webp/desktop_1280x720_latest.webp",
			"about/screenshots/webp/history/desktop_1280x720_<ts>.webp",
			"capture-report.json",
			"root/screenshots/jpg/desktop_1280x720_latest.jpg",
			"root/screenshots/jpg/history/desktop_1280x720_<ts>.jpg",
			"root/screenshots/png/desktop_1280x720_latest.png",
			"root/screenshots/png/history/desktop_1280x720_<ts>.png",
			"root/screenshots/webp/desktop_1280x720_latest.webp",
			"root/screenshots/webp/history/desktop_1280x720_<ts>.webp",
		]);
		// No `states/` segment anywhere in a run with no states, and a route
		// directory holds nothing but its screenshots.
		expect(files.some((file) => file.includes("/states/"))).toBe(false);
		expect((await fs.readdir(path.join(outputDir, "root"))).sort()).toEqual([
			"screenshots",
		]);

		const report = JSON.parse(
			await fs.readFile(path.join(outputDir, "capture-report.json"), "utf8"),
		);
		expect(report.totalRoutes).toBe(results.size);
		expect(report.totalRoutes).toBe(2);
		expect(report.totalStates).toBe(0);
		expect(report.skippedStates).toBe(0);
		expect(report.failedCaptures).toBe(0);
		expect(report.successfulCaptures).toBe(report.totalRoutes);
		// No result carries a state marker.
		for (const result of report.results) {
			expect(result.state).toBeUndefined();
			expect(result.stateStatus).toBeUndefined();
			expect(result.failedStepIndex).toBeUndefined();
		}
	}, 180_000);
});
