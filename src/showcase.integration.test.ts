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
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureShowcase } from "./showcase.js";
import { showPresentation } from "./showcase-presentation.js";

const exec = promisify(execFile);
const RUN = process.env.RUN_INTEGRATION === "1";
describe.skipIf(!RUN)("continuous showcase recording", () => {
	let server: http.Server;
	let seed: string;
	let output: string;
	let mutations = 0;
	let forbidden: http.Server;
	let forbiddenUrl: string;
	let forbiddenHits = 0;
	beforeAll(async () => {
		forbidden = http.createServer((_req, res) => {
			forbiddenHits++;
			res.end("forbidden");
		});
		await new Promise<void>((resolve) =>
			forbidden.listen(0, "127.0.0.1", resolve),
		);
		forbiddenUrl = `http://127.0.0.1:${(forbidden.address() as AddressInfo).port}/`;
		server = http.createServer((req, res) => {
			if (req.url === "/popup-hit") {
				mutations++;
				res.end("popup");
				return;
			}
			if (req.url === "/mutate") {
				mutations++;
				res.end("ok");
				return;
			}
			if (req.url === "/forbidden-redirect") {
				res.writeHead(302, { location: forbiddenUrl });
				res.end();
				return;
			}
			if (req.url === "/delayed") {
				res.setHeader("content-type", "text/html");
				res.end(
					`<body><h1 id="ready">Ready</h1><script>setTimeout(()=>location.href=${JSON.stringify(forbiddenUrl)},3500)</script></body>`,
				);
				return;
			}
			if (req.url === "/next") {
				res.setHeader("content-type", "text/html");
				res.end(
					'<body style="background:rgb(20,40,180);margin:0"><h1 id="next">Next page</h1></body>',
				);
				return;
			}
			res.setHeader("content-type", "text/html");
			res.end(
				`<!doctype html><body style="margin:0;background:rgb(180,20,20);font-family:sans-serif"><main style="min-height:1600px"><h1>Loading</h1><input id="search"><output id="query"></output><button id="open">Details</button><button id="popup" onclick="window.open('/popup-hit')">Popup</button><dialog><p>Case study</p><button id="close">Close</button></dialog><a href="/next" id="next-link" style="position:fixed;top:150px">Next</a><a id="offsite" href="http://example.invalid/blocked">Offsite</a></main><script>setTimeout(()=>{document.body.style.background='rgb(20,160,40)';document.querySelector('h1').id='ready';document.querySelector('h1').textContent='Ready'},700);document.querySelector('#search').oninput=e=>document.querySelector('#query').textContent=e.target.value;document.querySelector('#open').onclick=()=>document.querySelector('dialog').showModal();document.querySelector('#close').onclick=()=>document.querySelector('dialog').close();</script></body>`,
			);
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		seed = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
		output = await fs.mkdtemp(path.join(os.tmpdir(), "showcase-int-"));
	});
	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await new Promise<void>((resolve) => forbidden.close(() => resolve()));
		await fs.rm(output, { recursive: true, force: true });
	});
	const config = () => ({
		outputDir: output,
		viewports: [{ name: "fixture", width: 640, height: 360 }],
		waitUntil: "domcontentloaded" as const,
	});
	it("records typing, dialog, scroll and navigation once with correctly trimmed H264 video", async () => {
		mutations = 0;
		const [report] = await captureShowcase(
			seed,
			{
				version: 1,
				name: "complete",
				captions: false,
				cursor: false,
				scenes: [
					{
						name: "intro",
						readySelector: "#ready",
						caption: "Ready to explore",
						holdMs: 200,
						steps: [],
					},
					{
						name: "search",
						holdMs: 100,
						steps: [
							{ kind: "type", selector: "#search", value: "ResQ", delayMs: 70 },
							{ kind: "waitFor", selector: '#query:text-is("ResQ")' },
							{ kind: "click", selector: "#open" },
							{ kind: "waitFor", selector: "dialog[open]" },
						],
					},
					{
						name: "continue",
						holdMs: 100,
						steps: [
							{ kind: "waitFor", selector: "dialog[open]" },
							{ kind: "click", selector: "#close" },
							{ kind: "hover", selector: "#search" },
							{ kind: "scroll", y: 600, durationMs: 200 },
							{ kind: "request", method: "POST", path: "/mutate" },
							{ kind: "click", selector: "#next-link" },
							{ kind: "waitFor", selector: "#next" },
						],
					},
					{
						name: "last",
						holdMs: 400,
						steps: [{ kind: "waitFor", selector: "#next" }],
					},
				],
			},
			{ ...config(), allowStateRequests: true },
		);
		expect(report.status).toBe("complete");
		expect(report.scenes).toHaveLength(4);
		expect(
			report.scenes[1].steps[0].endMs - report.scenes[1].steps[0].startMs,
		).toBeGreaterThan(200);
		expect(mutations).toBe(1);
		const dir = report.outputDir;
		for (const file of [
			"showcase.mp4",
			"source.webm",
			"poster.png",
			"captions.srt",
			"report.json",
			"report.md",
			...report.scenes.map((scene) => `scenes/${scene.name}.png`),
		])
			expect((await fs.stat(path.join(dir, file))).size).toBeGreaterThan(0);
		const probe = JSON.parse(
			(
				await exec("ffprobe", [
					"-v",
					"error",
					"-show_streams",
					"-show_format",
					"-of",
					"json",
					path.join(dir, "showcase.mp4"),
				])
			).stdout,
		);
		expect(probe.streams[0]).toMatchObject({
			codec_name: "h264",
			pix_fmt: "yuv420p",
			width: 640,
			height: 360,
			r_frame_rate: "30/1",
			avg_frame_rate: "30/1",
		});
		expect(
			Math.abs(Number(probe.format.duration) * 1000 - report.durationMs),
		).toBeLessThan(100);
		expect(report.trimStartMs).toBeGreaterThan(500);
		const sample = async (time: string) =>
			(
				await exec(
					"ffmpeg",
					[
						"-v",
						"error",
						"-ss",
						time,
						"-i",
						path.join(dir, "showcase.mp4"),
						"-vf",
						"crop=20:20:600:300,scale=1:1",
						"-frames:v",
						"1",
						"-f",
						"rawvideo",
						"-pix_fmt",
						"rgb24",
						"pipe:1",
					],
					{ encoding: "buffer" },
				)
			).stdout;
		const first = await sample("0");
		expect(first[1]).toBeGreaterThan(120);
		expect(first[0]).toBeLessThan(50);
		const last = await sample(String(Number(probe.format.duration) - 0.15));
		expect(last[2]).toBeGreaterThan(140);
		expect(last[0]).toBeLessThan(50);
	});
	it("reports the actual failing scene and step and leaves no final video", async () => {
		await expect(
			captureShowcase(
				seed,
				{
					version: 1,
					name: "failure",
					scenes: [
						{ name: "first", readySelector: "#ready", holdMs: 0, steps: [] },
						{
							name: "broken",
							steps: [
								{ kind: "wait", ms: 10 },
								{ kind: "click", selector: "#missing", timeoutMs: 100 },
							],
						},
					],
				},
				config(),
			),
		).rejects.toThrow(/broken.*step 1/);
		const report = JSON.parse(
			await fs.readFile(
				path.join(output, "showcases/failure/fixture/report.json"),
				"utf8",
			),
		);
		expect(report.status).toBe("failed");
		expect(report.scenes[1].steps[1].status).toBe("failed");
		await expect(
			fs.stat(path.join(report.outputDir, "showcase.mp4")),
		).rejects.toThrow();
		expect(
			(await fs.stat(path.join(report.outputDir, "source.webm"))).size,
		).toBeGreaterThan(0);
	});
	it("cancels a running tour promptly and closes recording", async () => {
		const abort = new AbortController();
		const pending = captureShowcase(
			seed,
			{
				version: 1,
				name: "cancel",
				scenes: [
					{
						name: "waiting",
						readySelector: "#ready",
						steps: [{ kind: "wait", ms: 60000 }],
					},
				],
			},
			config(),
			{ signal: abort.signal },
		);
		setTimeout(() => abort.abort(new Error("fixture cancellation")), 1500);
		const start = Date.now();
		await expect(pending).rejects.toThrow(/cancellation/);
		expect(Date.now() - start).toBeLessThan(5000);
		const report = JSON.parse(
			await fs.readFile(
				path.join(output, "showcases/cancel/fixture/report.json"),
				"utf8",
			),
		);
		expect(report.status).toBe("failed");
		expect(
			(await fs.stat(path.join(report.outputDir, "source.webm"))).size,
		).toBeGreaterThan(0);
	});
	it("blocks a navigation outside the allowed origins", async () => {
		await expect(
			captureShowcase(
				seed,
				{
					version: 1,
					name: "host-gate",
					scenes: [
						{
							name: "blocked",
							readySelector: "#ready",
							steps: [{ kind: "click", selector: "#offsite" }],
						},
					],
				},
				config(),
			),
		).rejects.toThrow(/allowed origin/);
	});
	it("blocks server redirects before the forbidden target receives a request", async () => {
		forbiddenHits = 0;
		await expect(
			captureShowcase(
				seed,
				{
					version: 1,
					name: "redirect",
					scenes: [
						{ name: "redirected", url: "/forbidden-redirect", steps: [] },
					],
				},
				config(),
			),
		).rejects.toThrow(/allowed origin/);
		expect(forbiddenHits).toBe(0);
	});
	it("blocks API request redirects before the forbidden target receives a request", async () => {
		forbiddenHits = 0;
		await expect(
			captureShowcase(
				seed,
				{
					version: 1,
					name: "request-redirect",
					scenes: [
						{
							name: "redirected",
							readySelector: "#ready",
							steps: [
								{
									kind: "request",
									method: "POST",
									path: "/forbidden-redirect",
								},
							],
						},
					],
				},
				{ ...config(), allowStateRequests: true },
			),
		).rejects.toThrow(/allowed origin/);
		expect(forbiddenHits).toBe(0);
	});
	it("fails when a page navigates outside the gate during its final hold", async () => {
		forbiddenHits = 0;
		await expect(
			captureShowcase(
				seed,
				{
					version: 1,
					name: "delayed",
					scenes: [{ name: "held", url: "/delayed", holdMs: 4000, steps: [] }],
				},
				config(),
			),
		).rejects.toThrow(/allowed origin/);
		expect(forbiddenHits).toBe(0);
	});
	it("bounds a smooth scroll by its step deadline and reports the actual index", async () => {
		await expect(
			captureShowcase(
				seed,
				{
					version: 1,
					name: "step-deadline",
					scenes: [
						{
							name: "scrolling",
							readySelector: "#ready",
							steps: [
								{ kind: "wait", ms: 10 },
								{ kind: "scroll", y: 800, durationMs: 10000, timeoutMs: 100 },
							],
						},
					],
				},
				config(),
			),
		).rejects.toThrow(/scrolling.*step 1/);
		const report = JSON.parse(
			await fs.readFile(
				path.join(output, "showcases/step-deadline/fixture/report.json"),
				"utf8",
			),
		);
		expect(report.scenes[0].steps[1].status).toBe("failed");
		expect(
			report.scenes[0].steps[1].endMs - report.scenes[0].steps[1].startMs,
		).toBeLessThan(1000);
	});
	it("keeps long captions inside safe margins and follows cursor clicks", async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage({
				viewport: { width: 640, height: 360 },
			});
			await page.setContent(
				'<body style="background:rgb(20,160,40)">Presentation</body>',
			);
			await showPresentation(
				page,
				"A detailed portfolio caption. ".repeat(100),
				true,
			);
			await page.mouse.move(250, 180);
			await page.mouse.down();
			const geometry = await page.evaluate(() => {
				const root = document.getElementById(
					"ui-capture-presentation",
				)?.shadowRoot;
				const caption = root?.getElementById("caption");
				const pointer = root?.getElementById("pointer");
				const box = caption?.getBoundingClientRect();
				return {
					top: box?.top,
					left: box?.left,
					right: box?.right,
					bottom: box?.bottom,
					pointerX: pointer?.style.left,
					animations: pointer?.getAnimations().length,
					marker: document.getElementById("ui-capture-sync"),
				};
			});
			expect(geometry.top).toBeGreaterThanOrEqual(360 * 0.06);
			expect(geometry.left).toBeGreaterThanOrEqual(640 * 0.05);
			expect(geometry.right).toBeLessThanOrEqual(640 * 0.94);
			expect(geometry.bottom).toBeLessThanOrEqual(360 * 0.95);
			expect(geometry.pointerX).toBe("250px");
			expect(geometry.animations).toBeGreaterThan(0);
			expect(geometry.marker).toBeNull();
			await page.mouse.up();
		} finally {
			await browser.close();
		}
	});
	it("records optional failures without contradictory inherited step labels", async () => {
		const [report] = await captureShowcase(
			seed,
			{
				version: 1,
				name: "optional",
				scenes: [
					{
						name: "optional-scene",
						readySelector: "#ready",
						holdMs: 100,
						steps: [
							{ kind: "wait", ms: 10 },
							{
								kind: "click",
								selector: "#missing",
								optional: true,
								timeoutMs: 100,
							},
						],
					},
				],
			},
			config(),
		);
		expect(report.status).toBe("complete");
		expect(report.scenes[0].steps[1].status).toBe("optional-failed");
		expect(report.scenes[0].steps[1].error).not.toMatch(
			/state "showcase"|step 0/,
		);
	});
	it("retains elapsed execution time when first-scene readiness fails", async () => {
		await expect(
			captureShowcase(
				seed,
				{
					version: 1,
					name: "preroll-failure",
					scenes: [
						{
							name: "not-ready",
							readySelector: "#never",
							timeoutMs: 300,
							steps: [],
						},
					],
				},
				config(),
			),
		).rejects.toThrow(/not-ready.*readiness/);
		const report = JSON.parse(
			await fs.readFile(
				path.join(output, "showcases/preroll-failure/fixture/report.json"),
				"utf8",
			),
		);
		expect(report.executionDurationMs).toBeGreaterThanOrEqual(300);
		expect(
			report.scenes[0].executionEndMs - report.scenes[0].executionStartMs,
		).toBeGreaterThanOrEqual(250);
		expect(report.status).toBe("failed");
	});
	it("rejects popup requests before they reach the server", async () => {
		mutations = 0;
		await expect(
			captureShowcase(
				seed,
				{
					version: 1,
					name: "popup",
					scenes: [
						{
							name: "popup-scene",
							readySelector: "#ready",
							steps: [{ kind: "click", selector: "#popup" }],
						},
					],
				},
				config(),
			),
		).rejects.toThrow(/popup/);
		expect(mutations).toBe(0);
	});
	it("starts subtitle cues when captions actually appear after readiness", async () => {
		const [report] = await captureShowcase(
			seed,
			{
				version: 1,
				name: "caption-timing",
				scenes: [
					{ name: "first", readySelector: "#ready", holdMs: 100, steps: [] },
					{
						name: "loaded",
						url: "/",
						readySelector: "#ready",
						caption: "Second page",
						holdMs: 200,
						steps: [],
					},
				],
			},
			config(),
		);
		const scene = report.scenes[1];
		expect(scene.captionStartMs - scene.startMs).toBeGreaterThan(600);
		const cues = await fs.readFile(
			path.join(report.outputDir, "captions.srt"),
			"utf8",
		);
		const match = cues.match(/(\d+):(\d+):(\d+),(\d+) -->/);
		expect(match).not.toBeNull();
		const start =
			Number(match?.[1]) * 3600000 +
			Number(match?.[2]) * 60000 +
			Number(match?.[3]) * 1000 +
			Number(match?.[4]);
		expect(start).toBe(scene.captionStartMs);
	});

	it("does not overwrite an existing run", async () => {
		await expect(
			captureShowcase(
				seed,
				{
					version: 1,
					name: "complete",
					scenes: [{ name: "intro", steps: [] }],
				},
				config(),
			),
		).rejects.toThrow(/already exists/);
	});
});
