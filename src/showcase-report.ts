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
import type { ShowcaseReport } from "./showcase.js";
import { createShowcaseSrt } from "./showcase-export.js";

export const writeShowcaseReport = async (
	report: ShowcaseReport,
): Promise<void> => {
	const tableText = (value: string) => value.replace(/[|\r\n]/g, " ");
	const lines = [
		`# ${report.title ?? report.name}`,
		"",
		`Status: ${report.status}`,
		`Duration: ${(report.durationMs / 1000).toFixed(2)} seconds`,
		"",
		...(report.error ? [`Error: ${report.error}`, ""] : []),
		"| Scene | Start (ms) | End (ms) | Status |",
		"| --- | ---: | ---: | --- |",
		...report.scenes.map(
			(scene) =>
				`| ${tableText(scene.name)} | ${scene.startMs} | ${scene.endMs} | ${scene.status} |`,
		),
		"",
		...report.scenes.flatMap((scene) => [
			`## ${scene.name}`,
			"",
			...scene.steps.map(
				(step) =>
					`- Step ${step.index} (${step.kind}): ${step.status}, ${step.startMs}–${step.endMs} ms${step.error ? ` — ${step.error}` : ""}`,
			),
			"",
		]),
	];
	try {
		await fs.writeFile(
			path.join(report.outputDir, "report.md"),
			lines.join("\n"),
		);
		await fs.writeFile(
			path.join(report.outputDir, "captions.srt"),
			createShowcaseSrt(
				report.scenes.map((scene) => ({
					...scene,
					startMs: scene.captionStartMs ?? scene.startMs,
				})),
			),
		);
		await fs.writeFile(
			path.join(report.outputDir, "report.json"),
			`${JSON.stringify(report, null, 2)}\n`,
		);
	} catch (error) {
		report.status = "failed";
		report.error = `Report finalization failed: ${error instanceof Error ? error.message : String(error)}`;
		const reportPath = path.join(report.outputDir, "report.json");
		try {
			await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
		} catch {
			await fs.rm(reportPath, { force: true }).catch(() => {});
		}

		const markdownPath = path.join(report.outputDir, "report.md");
		try {
			await fs.writeFile(
				markdownPath,
				`# ${report.name}\n\nStatus: failed\n\n${report.error}\n`,
			);
		} catch {
			await fs.rm(markdownPath, { force: true }).catch(() => {});
		}
		throw error;
	}
};
