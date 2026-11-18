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
// cspell:words lavfi libx EXTM

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importMusic } from "./music.js";
import { mixMusic } from "./music-mix.js";

const exec = promisify(execFile);
describe.skipIf(process.env.RUN_INTEGRATION !== "1")(
	"real soundtrack mixing",
	() => {
		let dir: string, video: string, manifest: string;
		beforeEach(async () => {
			dir = await fs.mkdtemp(path.join(os.tmpdir(), "music-mix-"));
			video = path.join(dir, "video.mp4");
			const tone = path.join(dir, "tone.wav");
			await exec("ffmpeg", [
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"color=c=green:s=160x90:r=25:d=4",
				"-c:v",
				"libx264",
				video,
			]);
			await exec("ffmpeg", [
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=440:duration=4",
				tone,
			]);
			await importMusic(tone, {
				title: "Generated tone",
				creator: "Test",
				sourceUrl: "https://example.com/generated",
				license: "test-fixture",
				licenseUrl: "https://example.com/license",
				outputDir: path.join(dir, "track"),
			});
			manifest = path.join(dir, "track", "track.json");
		});
		afterEach(async () => fs.rm(dir, { recursive: true, force: true }));
		const streamHash = async (file: string) =>
			(
				await exec("ffmpeg", [
					"-v",
					"error",
					"-i",
					file,
					"-map",
					"0:v:0",
					"-c",
					"copy",
					"-f",
					"hash",
					"-hash",
					"sha256",
					"-",
				])
			).stdout;
		const audio = async (file: string) => {
			const { stdout } = await exec(
				"ffmpeg",
				[
					"-v",
					"error",
					"-i",
					file,
					"-map",
					"0:a:0",
					"-ac",
					"1",
					"-ar",
					"8000",
					"-f",
					"f32le",
					"-",
				],
				{ encoding: "buffer", maxBuffer: 1024 * 1024 },
			);
			return new Float32Array(
				stdout.buffer,
				stdout.byteOffset,
				stdout.length / 4,
			);
		};
		const rms = (data: Float32Array, from: number, to: number) => {
			const section = data.slice(
				Math.round(from * 8000),
				Math.round(to * 8000),
			);
			return Math.sqrt(
				section.reduce((sum, x) => sum + x * x, 0) / section.length,
			);
		};
		it("preserves compressed video frames, duration and dimensions and adds audible fades", async () => {
			const before = await fs.readFile(video);
			const outputPath = path.join(dir, "mixed.mp4");
			await mixMusic(video, manifest, {
				outputPath,
				volume: 0.4,
				fadeIn: 1,
				fadeOut: 1,
			});
			expect(await fs.readFile(video)).toEqual(before);
			expect(await streamHash(outputPath)).toBe(await streamHash(video));
			const metadata = JSON.parse(
				(
					await exec("ffprobe", [
						"-v",
						"error",
						"-show_streams",
						"-show_format",
						"-of",
						"json",
						outputPath,
					])
				).stdout,
			);
			expect(metadata.streams[0]).toMatchObject({
				width: 160,
				height: 90,
				r_frame_rate: "25/1",
			});
			expect(metadata.streams[1].codec_name).toBe("aac");
			expect(Number(metadata.format.duration)).toBeCloseTo(4, 1);
			const samples = await audio(outputPath);
			const middle = rms(samples, 1.5, 2.5);
			expect(middle).toBeGreaterThan(0.02);
			expect(rms(samples, 0, 0.1)).toBeLessThan(middle * 0.2);
			expect(rms(samples, 3.9, 3.98)).toBeLessThan(middle * 0.2);
			expect(await fs.readFile(`${outputPath}.credits.txt`, "utf8")).toContain(
				"Generated tone",
			);
			expect(
				JSON.parse(await fs.readFile(`${outputPath}.music.json`, "utf8")).track
					.sha256,
			).toMatch(/^[a-f0-9]{64}$/);
		});
		it("pads short audio with silence unless looping is explicit", async () => {
			const tone = path.join(dir, "short.wav");
			await exec("ffmpeg", [
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=440:duration=0.5",
				tone,
			]);
			await importMusic(tone, {
				title: "Short tone",
				creator: "Test",
				sourceUrl: "https://example.com/generated",
				license: "test-fixture",
				licenseUrl: "https://example.com/license",
				outputDir: path.join(dir, "short"),
			});
			const track = path.join(dir, "short", "track.json");
			const outputPath = path.join(dir, "padded.mp4");
			await mixMusic(video, track, { outputPath, fadeIn: 0, fadeOut: 0 });
			expect(rms(await audio(outputPath), 2, 3)).toBeLessThan(0.0001);
			const looped = path.join(dir, "looped.mp4");
			await mixMusic(video, track, {
				outputPath: looped,
				loop: true,
				fadeIn: 0,
				fadeOut: 0,
			});
			expect(rms(await audio(looped), 2, 3)).toBeGreaterThan(0.01);
		});
		it("rejects disguised playlists and leaves no asset", async () => {
			const playlist = path.join(dir, "fake.wav");
			await fs.writeFile(playlist, `#EXTM3U\n${video}\n`);
			const outputDir = path.join(dir, "bad");
			await expect(
				importMusic(playlist, {
					title: "Bad",
					creator: "Test",
					sourceUrl: "https://example.com",
					license: "test",
					licenseUrl: "https://example.com",
					outputDir,
				}),
			).rejects.toThrow();
			expect(await fs.stat(outputDir).catch(() => undefined)).toBeUndefined();
		});
		it("cancels an active real FFmpeg mix and removes partial media and sidecars", async () => {
			const encoder = path.join(dir, "slow-encoder");
			const pidFile = path.join(dir, "encoder-pid");
			await fs.writeFile(
				encoder,
				`#!/bin/sh\necho $$ > '${pidFile}'\nexec ffmpeg -re "$@"\n`,
				{ mode: 0o755 },
			);
			const outputPath = path.join(dir, "cancelled.mp4");
			const controller = new AbortController();
			const pending = mixMusic(video, manifest, {
				outputPath,
				ffmpegPath: encoder,
				signal: controller.signal,
			});
			const rejected = expect(pending).rejects.toThrow(/cancel/i);
			while (!(await fs.stat(pidFile).catch(() => undefined)))
				await new Promise((resolve) => setTimeout(resolve, 5));
			controller.abort();
			await rejected;
			const pid = Number(await fs.readFile(pidFile, "utf8"));
			expect(() => process.kill(pid, 0)).toThrow();
			expect(
				(await fs.readdir(dir)).some((name) => name.includes("cancelled")),
			).toBe(false);
		});
		it("rolls back media and credits if FFmpeg fails", async () => {
			const encoder = path.join(dir, "bad-encoder");
			await fs.writeFile(
				encoder,
				'#!/bin/sh\nexec ffmpeg -invalid-fixture-option "$@"\n',
				{ mode: 0o755 },
			);
			const outputPath = path.join(dir, "failed.mp4");
			await expect(
				mixMusic(video, manifest, { outputPath, ffmpegPath: encoder }),
			).rejects.toThrow(/exited/);
			expect(
				(await fs.readdir(dir)).some((name) => name.includes("failed")),
			).toBe(false);
		});
		it("rejects pre-cancellation and existing provenance without changing input", async () => {
			const outputPath = path.join(dir, "cancel.mp4");
			await expect(
				mixMusic(video, manifest, { outputPath, signal: AbortSignal.abort() }),
			).rejects.toThrow();
			expect(await fs.stat(outputPath).catch(() => undefined)).toBeUndefined();
			await fs.writeFile(`${outputPath}.credits.txt`, "keep");
			await expect(mixMusic(video, manifest, { outputPath })).rejects.toThrow(
				/exist/,
			);
			expect(await fs.readFile(`${outputPath}.credits.txt`, "utf8")).toBe(
				"keep",
			);
		});
	},
);
