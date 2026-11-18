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
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mixMusic, validateMusicMixSettings } from "./music-mix.js";
import { runMusicProcess } from "./music-process.js";

describe("music mix validation", () => {
	it("defaults to modest gain, fades and no loop", () =>
		expect(validateMusicMixSettings({})).toEqual({
			volume: 0.18,
			fadeIn: 1,
			fadeOut: 2,
			loop: false,
		}));
	it.each([
		{ volume: -1 },
		{ volume: 2 },
		{ volume: NaN },
		{ fadeIn: -1 },
		{ fadeOut: 31 },
		{ loop: "yes" },
	])("rejects invalid parameters %j", (settings) =>
		expect(() => validateMusicMixSettings(settings as never)).toThrow());
});
describe("music process lifetime", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "music-process-"));
	});
	afterEach(async () => fs.rm(dir, { recursive: true, force: true }));
	it("terminates stalled processes within a bounded budget", async () => {
		await expect(
			runMusicProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
				timeoutMs: 40,
			}),
		).rejects.toThrow(/timed out/);
	});
	it("kills an active process before returning cancellation", async () => {
		const pidFile = path.join(dir, "pid");
		const controller = new AbortController();
		const pending = runMusicProcess(
			process.execPath,
			[
				"-e",
				`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
			],
			{ signal: controller.signal },
		);
		const rejected = expect(pending).rejects.toThrow(/cancel/);
		while (!(await fs.stat(pidFile).catch(() => undefined)))
			await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort();
		await rejected;
		const pid = Number(await fs.readFile(pidFile, "utf8"));
		expect(() => process.kill(pid, 0)).toThrow();
	});
	it("preserves an existing output without invoking media tools", async () => {
		const outputPath = path.join(dir, "existing.mp4");
		await fs.writeFile(outputPath, "keep");
		await expect(
			mixMusic("missing.mp4", "missing.json", { outputPath }),
		).rejects.toThrow(/exist/);
		expect(await fs.readFile(outputPath, "utf8")).toBe("keep");
	});
});
