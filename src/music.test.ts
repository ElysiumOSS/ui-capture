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

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fetchMusic,
	importMusic,
	loadMusicManifest,
	searchMusic,
} from "./music.js";
import { readMusicUrl } from "./music-http.js";

vi.mock("./music-http.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./music-http.js")>()),
	readMusicUrl: vi.fn(),
}));
const record = {
	id: "297e676f-18e5-478c-9a39-e707f56eb5be",
	title: "Tone",
	creator: "Test Artist",
	category: "music",
	license: "by",
	license_version: "3.0",
	license_url: "https://creativecommons.org/licenses/by/3.0/",
	foreign_landing_url: "https://example.com/track",
	url: "https://example.com/audio",
	attribution: "Tone by Test Artist",
};
describe("local music assets", () => {
	let dir: string, probe: string, input: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-music-"));
		probe = path.join(dir, "probe");
		input = path.join(dir, "tone.wav");
		await fs.writeFile(input, "audio fixture");
		await fs.writeFile(
			probe,
			'#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({streams:[{codec_type:"audio",codec_name:"pcm_s16le"}],format:{duration:"2",format_name:"wav"}}));',
			{ mode: 0o755 },
		);
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
		vi.resetAllMocks();
	});
	const metadata = {
		title: "Tone",
		creator: "Test Artist",
		sourceUrl: "https://example.com/track",
		license: "mixkit-free",
		licenseUrl: "https://mixkit.co/license/modal/musicFree/",
	};
	it("imports a local track with a relative path, hash, credits and preview", async () => {
		const out = path.join(dir, "import");
		const result = await importMusic(input, {
			...metadata,
			outputDir: out,
			ffprobePath: probe,
		});
		expect(result.audio).toBe("audio.wav");
		expect(result.sha256).toBe(
			createHash("sha256").update("audio fixture").digest("hex"),
		);
		expect(
			(await loadMusicManifest(path.join(out, "track.json"))).track,
		).toMatchObject({ title: "Tone", provider: "manual" });
		expect(await fs.readFile(path.join(out, "credits.txt"), "utf8")).toContain(
			metadata.licenseUrl,
		);
		expect(await fs.readFile(path.join(out, "index.html"), "utf8")).toContain(
			'src="audio.wav"',
		);
	});
	it("never overwrites an asset directory", async () => {
		const outputDir = path.join(dir, "existing");
		await fs.mkdir(outputDir);
		await fs.writeFile(path.join(outputDir, "keep"), "keep");
		await expect(
			importMusic(input, { ...metadata, outputDir, ffprobePath: probe }),
		).rejects.toThrow(/exist/);
		expect(await fs.readFile(path.join(outputDir, "keep"), "utf8")).toBe(
			"keep",
		);
	});
	it("cleans failed media probes without leaving a completed manifest", async () => {
		const outputDir = path.join(dir, "failed");
		await expect(
			importMusic(input, {
				...metadata,
				outputDir,
				ffprobePath: "/no/such/probe",
			}),
		).rejects.toThrow();
		expect(await fs.stat(outputDir).catch(() => undefined)).toBeUndefined();
	});
	it("imports one explicitly chosen URL through the same bounded downloader", async () => {
		vi.mocked(readMusicUrl).mockImplementation(async (_url, options) => {
			await fs.writeFile(
				options.destination ?? "missing fixture destination",
				"selected remote audio",
			);
			return Buffer.alloc(0);
		});
		const result = await importMusic(
			"https://assets.example.com/selected.mp3",
			{ ...metadata, outputDir: path.join(dir, "remote"), ffprobePath: probe },
		);
		expect(result.provider).toBe("manual");
		expect(readMusicUrl).toHaveBeenCalledTimes(1);
		expect(vi.mocked(readMusicUrl).mock.calls[0][1].kind).toBe("audio");
	});
	it("requires explicit manual license details", async () => {
		await expect(
			importMusic(input, {
				...metadata,
				licenseUrl: "",
				outputDir: path.join(dir, "bad"),
				ffprobePath: probe,
			}),
		).rejects.toThrow(/license/i);
	});
	it("rejects metadata that would produce an unusable manifest", async () => {
		for (const override of [
			{ licenseVersion: "x".repeat(31) },
			{ title: "a".repeat(6000), creator: "b".repeat(6000) },
		]) {
			const outputDir = path.join(dir, "invalid-metadata");
			await expect(
				importMusic(input, {
					...metadata,
					...override,
					outputDir,
					ffprobePath: probe,
				}),
			).rejects.toThrow(/version|attribution|manifest/i);
			expect(await fs.stat(outputDir).catch(() => undefined)).toBeUndefined();
		}
	});
	it("rejects modified audio, escaping paths and escaping symlinks", async () => {
		const outputDir = path.join(dir, "import");
		const manifest = await importMusic(input, {
			...metadata,
			outputDir,
			ffprobePath: probe,
		});
		const file = path.join(outputDir, "track.json");
		await fs.appendFile(path.join(outputDir, manifest.audio), "changed");
		await expect(loadMusicManifest(file)).rejects.toThrow(/hash|SHA/);
		for (const audio of [
			"../tone.wav",
			"/etc/passwd",
			"https://example.com/song",
		]) {
			await fs.writeFile(file, JSON.stringify({ ...manifest, audio }));
			await expect(loadMusicManifest(file)).rejects.toThrow(/path/);
		}
		await fs.symlink(input, path.join(outputDir, "escape.wav"));
		await fs.writeFile(
			file,
			JSON.stringify({ ...manifest, audio: "escape.wav" }),
		);
		await expect(loadMusicManifest(file)).rejects.toThrow(/path|outside/);
	});
	it("fetches fresh metadata, probes audio and records the selected UUID", async () => {
		vi.mocked(readMusicUrl).mockImplementation(async (_url, options) => {
			if (options.kind === "json") return Buffer.from(JSON.stringify(record));
			await fs.writeFile(
				options.destination ?? "missing fixture destination",
				"downloaded",
			);
			return Buffer.alloc(0);
		});
		const result = await fetchMusic(record.id, {
			outputDir: path.join(dir, "download"),
			ffprobePath: probe,
		});
		expect(result.id).toBe(record.id);
		expect(readMusicUrl).toHaveBeenCalledTimes(2);
		expect(vi.mocked(readMusicUrl).mock.calls[0][0]).toBe(
			`https://api.openverse.org/v1/audio/${record.id}/`,
		);
	});
	it("rejects fresh disallowed metadata before downloading", async () => {
		vi.mocked(readMusicUrl).mockResolvedValue(
			Buffer.from(JSON.stringify({ ...record, license: "by-nc" })),
		);
		await expect(
			fetchMusic(record.id, {
				outputDir: path.join(dir, "bad"),
				ffprobePath: probe,
			}),
		).rejects.toThrow(/license/);
		expect(readMusicUrl).toHaveBeenCalledTimes(1);
	});
	it("writes only the requested search page, omitting invalid provider records", async () => {
		vi.mocked(readMusicUrl).mockResolvedValue(
			Buffer.from(
				JSON.stringify({
					results: [record, { ...record, license: "by-nc" }],
					next: "https://example.com/next",
				}),
			),
		);
		const outputDir = path.join(dir, "search");
		const results = await searchMusic("ambient", { outputDir, limit: 1 });
		expect(results).toHaveLength(1);
		expect(readMusicUrl).toHaveBeenCalledTimes(1);
		expect(
			JSON.parse(
				await fs.readFile(path.join(outputDir, "results.json"), "utf8"),
			).tracks,
		).toHaveLength(1);
	});
	it("rolls back when cancelled during final manifest publication", async () => {
		const outputDir = path.join(dir, "publish-cancelled");
		const controller = new AbortController();
		const originalLink = fs.link.bind(fs);
		const spy = vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
			await originalLink(from, to);
			if (String(to).endsWith("track.json")) controller.abort();
		});
		try {
			await expect(
				importMusic(input, {
					...metadata,
					outputDir,
					ffprobePath: probe,
					signal: controller.signal,
				}),
			).rejects.toThrow(/abort/i);
			expect(await fs.stat(outputDir).catch(() => undefined)).toBeUndefined();
		} finally {
			spy.mockRestore();
		}
	});
	it("rejects cancelled imports without publishing", async () => {
		const outputDir = path.join(dir, "cancelled");
		await expect(
			importMusic(input, {
				...metadata,
				outputDir,
				ffprobePath: probe,
				signal: AbortSignal.abort(),
			}),
		).rejects.toThrow();
		expect(await fs.stat(outputDir).catch(() => undefined)).toBeUndefined();
	});
});
