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
import { afterEach, expect, it, vi } from "vitest";
import type { ShowcaseReport } from "./showcase.js";
import { writeShowcaseReport } from "./showcase-report.js";

afterEach(() => vi.restoreAllMocks());
it.each([
	"report.md",
	"captions.srt",
	"report.json",
])("never leaves a complete report when %s cannot be written", async (failedFile) => {
	const outputDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "showcase-report-"),
	);
	const original = fs.writeFile;
	vi.spyOn(fs, "writeFile").mockImplementation(async (file, ...args) => {
		if (String(file).endsWith(failedFile)) throw new Error("disk failure");
		return original(file, ...args);
	});
	const report: ShowcaseReport = {
		version: 1,
		name: "report",
		status: "complete",
		outputDir,
		viewport: { name: "desktop", width: 640, height: 360 },
		startedAt: new Date().toISOString(),
		durationMs: 1000,
		executionDurationMs: 1000,
		scenes: [],
	};
	try {
		await expect(writeShowcaseReport(report)).rejects.toThrow(/disk failure/);

		expect(report.status).toBe("failed");
		for (const filename of ["report.json", "report.md"]) {
			const saved = await fs
				.readFile(path.join(outputDir, filename), "utf8")
				.catch((error) => {
					if (error.code === "ENOENT") return "";
					throw error;
				});
			expect(saved).not.toMatch(/Status: complete|"status": "complete"/);
			if (saved) expect(saved).toMatch(/failed/);
		}
	} finally {
		vi.restoreAllMocks();
		await fs.rm(outputDir, { recursive: true, force: true });
	}
});
