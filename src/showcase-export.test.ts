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
// cspell:words libx faststart lavfi drawbox ffprobe rawvideo moov mdat

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildShowcaseFfmpegArgs,
	createShowcaseSrt,
	exportShowcase,
	findMarkerEnd,
} from "./showcase-export.js";

const exec = promisify(execFile);
const samples = (...colors: number[][]) => Buffer.from(colors.flat());
const black = [0, 0, 0];
const magenta = [250, 3, 250];
const cyan = [3, 250, 250];
const green = [0, 250, 0];

describe("showcase export planning", () => {
	it("ignores natural magenta before the full magenta cyan magenta marker", () => {
		expect(
			findMarkerEnd(
				samples(
					black,
					magenta,
					magenta,
					magenta,
					black,
					magenta,
					magenta,
					magenta,
					cyan,
					cyan,
					cyan,
					magenta,
					magenta,
					magenta,
					green,
				),
			),
		).toBe((14 / 30) * 1000);
	});

	it("rejects absent or unfinished synchronization markers", () => {
		expect(() => findMarkerEnd(samples(black, green))).toThrow(/marker/i);
		expect(() => findMarkerEnd(samples(magenta, magenta, magenta))).toThrow(
			/marker/i,
		);
		expect(() =>
			findMarkerEnd(samples(magenta, magenta, magenta, green)),
		).toThrow(/marker/i);
		expect(() =>
			findMarkerEnd(
				samples(
					magenta,
					magenta,
					magenta,
					cyan,
					cyan,
					magenta,
					magenta,
					magenta,
					green,
				),
			),
		).toThrow(/marker/i);
		expect(() =>
			findMarkerEnd(
				samples(
					magenta,
					magenta,
					magenta,
					cyan,
					cyan,
					cyan,
					magenta,
					magenta,
					green,
				),
			),
		).toThrow(/marker/i);
	});

	it("keeps paths as arguments and exports padded H.264 constant-rate video", () => {
		const args = buildShowcaseFfmpegArgs(
			"/tmp/source $(oops).webm",
			"/tmp/final name.mp4",
			1400,
			2000,
		);
		expect(args).toContain("/tmp/source $(oops).webm");
		expect(args.at(-1)).toBe("/tmp/final name.mp4");
		expect(args.join(" ")).toContain("libx264");
		expect(args.join(" ")).toContain("yuv420p");
		expect(args.join(" ")).toContain("pad=ceil(iw/2)*2:ceil(ih/2)*2");
		expect(args.join(" ")).toContain("fps=30");
		expect(args.join(" ")).toContain("+faststart");
		expect(args[args.indexOf("-t") + 1]).toBe("2.000000");
	});

	it("formats only nonempty captions with millisecond boundaries and plain text", () => {
		expect(
			createShowcaseSrt([
				{ caption: "", startMs: 0, endMs: 50 },
				{
					caption: "Search <projects> & inspect\n\nresults",
					startMs: 1234.4,
					endMs: 3789.6,
				},
				{ caption: "Finish", startMs: 3600123, endMs: 3601123 },
			]),
		).toBe(
			"1\n00:00:01,234 --> 00:00:03,790\nSearch &lt;projects&gt; &amp; inspect\nresults\n\n2\n01:00:00,123 --> 01:00:01,123\nFinish\n",
		);
	});
});

describe("showcase encoder lifetime", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-showcase-export-"));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	const fakeEncoder = async (body: string) => {
		const file = path.join(dir, "encoder");
		await fs.writeFile(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
		return file;
	};
	const markerProbe =
		"...Array(3).fill([255,0,255]).flat(), ...Array(3).fill([0,255,255]).flat(), ...Array(3).fill([255,0,255]).flat()";
	const completeProbe = `Buffer.from([${markerProbe}, ...Array(30).fill([0,255,0]).flat()])`;

	it("preserves an existing final artifact", async () => {
		const outputPath = path.join(dir, "showcase.mp4");
		await fs.writeFile(outputPath, "existing");
		await expect(
			exportShowcase({
				ffmpegPath: "never-run",
				sourcePath: "source",
				outputPath,
				durationMs: 500,
			}),
		).rejects.toThrow(/exist/i);
		expect(await fs.readFile(outputPath, "utf8")).toBe("existing");
	});

	it("removes partial output when encoding fails", async () => {
		const ffmpegPath = await fakeEncoder(`const fs = require('node:fs');
if (process.argv.at(-1) === 'pipe:1') process.stdout.write(${completeProbe});
else { fs.writeFileSync(process.argv.at(-1), 'partial'); process.stderr.write('fixture encoder failure'); process.exitCode = 7; }`);
		await expect(
			exportShowcase({
				ffmpegPath,
				sourcePath: "source",
				outputPath: path.join(dir, "showcase.mp4"),
				durationMs: 500,
			}),
		).rejects.toThrow(/fixture encoder failure/);
		expect(await fs.readdir(dir)).toEqual(["encoder"]);
	});

	it("rejects a source that ends before the declared tour is complete", async () => {
		const ffmpegPath = await fakeEncoder(`const fs = require('node:fs');
if (process.argv.at(-1) === 'pipe:1') process.stdout.write(Buffer.from([${markerProbe},0,255,0]));
else fs.writeFileSync(process.argv.at(-1), 'truncated');`);
		await expect(
			exportShowcase({
				ffmpegPath,
				sourcePath: "source",
				outputPath: path.join(dir, "showcase.mp4"),
				durationMs: 500,
			}),
		).rejects.toThrow(/short|ended|duration/i);
		expect(await fs.readdir(dir)).toEqual(["encoder"]);
	});

	it("kills a stalled encoder on timeout and waits for its process to exit", async () => {
		const pidPath = path.join(dir, "pid");
		const ffmpegPath = await fakeEncoder(`const fs = require('node:fs');
if (process.argv.at(-1) === 'pipe:1') process.stdout.write(${completeProbe});
else { fs.writeFileSync(process.argv.at(-1), 'partial'); fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000); }`);
		await expect(
			exportShowcase({
				ffmpegPath,
				sourcePath: "source",
				outputPath: path.join(dir, "showcase.mp4"),
				durationMs: 500,
				timeoutMs: 300,
			}),
		).rejects.toThrow(/timed out/);
		const pid = Number(await fs.readFile(pidPath, "utf8"));
		expect(() => process.kill(pid, 0)).toThrow();
		expect((await fs.readdir(dir)).sort()).toEqual(["encoder", "pid"]);
	});

	it("kills an active encoder when cancelled", async () => {
		const pidPath = path.join(dir, "pid");
		const ffmpegPath = await fakeEncoder(
			`require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
		);
		const controller = new AbortController();
		const result = exportShowcase({
			ffmpegPath,
			sourcePath: "source",
			outputPath: path.join(dir, "showcase.mp4"),
			durationMs: 500,
			signal: controller.signal,
		});
		const rejected = expect(result).rejects.toThrow(/abort|cancel/i);
		while (!(await fs.stat(pidPath).catch(() => undefined)))
			await new Promise((resolve) => setTimeout(resolve, 10));
		controller.abort();
		await rejected;
		const pid = Number(await fs.readFile(pidPath, "utf8"));
		expect(() => process.kill(pid, 0)).toThrow();
		expect((await fs.readdir(dir)).sort()).toEqual(["encoder", "pid"]);
	});
});

describe.skipIf(process.env.RUN_INTEGRATION !== "1")(
	"real showcase export",
	() => {
		let dir: string;
		beforeEach(async () => {
			dir = await fs.mkdtemp(
				path.join(os.tmpdir(), "ui-showcase-real-export-"),
			);
		});
		afterEach(async () => {
			await fs.rm(dir, { recursive: true, force: true });
		});

		it("trims loading and marker frames and emits a real timed H.264 MP4", async () => {
			const sourcePath = path.join(dir, "source.webm");
			const outputPath = path.join(dir, "showcase.mp4");
			await exec("ffmpeg", [
				"-y",
				"-loglevel",
				"error",
				"-f",
				"lavfi",
				"-i",
				"color=c=green:s=160x90:r=25:d=4",
				"-vf",
				"drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='lt(t,1)',drawbox=x=0:y=0:w=32:h=32:color=magenta:t=fill:enable='gte(t,0.2)*lt(t,0.6)+gte(t,1)*lt(t,1.4)+gte(t,1.8)*lt(t,2.2)',drawbox=x=0:y=0:w=32:h=32:color=cyan:t=fill:enable='gte(t,1.4)*lt(t,1.8)'",
				"-c:v",
				"libvpx",
				"-b:v",
				"200k",
				sourcePath,
			]);
			const result = await exportShowcase({
				ffmpegPath: "ffmpeg",
				sourcePath,
				outputPath,
				durationMs: 1200,
			});
			expect(result.trimStartMs).toBeCloseTo(2200, -2);
			const { stdout } = await exec("ffprobe", [
				"-v",
				"error",
				"-show_streams",
				"-show_format",
				"-of",
				"json",
				outputPath,
			]);
			const metadata = JSON.parse(stdout);
			expect(metadata.streams[0]).toMatchObject({
				codec_name: "h264",
				pix_fmt: "yuv420p",
				width: 160,
				height: 90,
				r_frame_rate: "30/1",
			});
			expect(Number(metadata.format.duration)).toBeCloseTo(1.2, 1);
			expect(Number(metadata.format.size)).toBeGreaterThan(1000);
			const frame = await exec(
				"ffmpeg",
				[
					"-v",
					"error",
					"-i",
					outputPath,
					"-frames:v",
					"1",
					"-vf",
					"crop=16:16:0:0,scale=1:1",
					"-f",
					"rawvideo",
					"-pix_fmt",
					"rgb24",
					"pipe:1",
				],
				{ encoding: "buffer" },
			);
			expect(frame.stdout[1]).toBeGreaterThan(90);
			expect(frame.stdout[0]).toBeLessThan(30);
			expect(frame.stdout[2]).toBeLessThan(30);
			const bytes = await fs.readFile(outputPath);
			expect(bytes.indexOf("moov")).toBeLessThan(bytes.indexOf("mdat"));
		}, 30000);
	},
);
