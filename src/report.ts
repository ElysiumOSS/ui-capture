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
import { Effect } from "effect";
import { FileSystemError } from "./errors.js";
import {
	CaptureReport,
	type CaptureResult,
	type ViewportConfig,
} from "./schemas.js";

/** A capture unit's heading: the route, or `route \u2014 state` for a state. */
const captureLabel = (result: CaptureResult): string =>
	result.state ? `${result.route} \u2014 ${result.state}` : result.route;

const generateMarkdown = (
	outputDir: string,
	counts: {
		readonly totalRoutes: number;
		readonly totalStates: number;
	},
	successful: CaptureResult[],
	failed: CaptureResult[],
	states: CaptureResult[],
): string => {
	let md = "# UI Capture Report\n\n";
	md += `Generated: ${new Date().toISOString()}\n\n`;
	md += "## Summary\n\n";
	md += `- Total Routes: ${counts.totalRoutes}\n`;
	if (counts.totalStates > 0) {
		md += `- Scripted States: ${counts.totalStates}\n`;
	}
	md += `- Successful: ${successful.length}\n`;
	md += `- Failed: ${failed.length}\n\n`;

	if (states.length > 0) {
		md += "## Scripted States\n\n";
		md += "| State | Route | URL | Result | Step |\n";
		md += "| ----- | ----- | --- | ------ | ---- |\n";
		for (const result of states) {
			const status =
				result.stateStatus === "captured"
					? "\u2713 captured"
					: result.stateStatus === "skipped"
						? "\u2013 skipped"
						: "\u2717 failed";
			const step =
				result.failedStepIndex === undefined || result.failedStepIndex < 0
					? ""
					: `step ${result.failedStepIndex}`;
			md += `| ${result.state} | ${result.route} | ${result.url} | ${status} | ${step} |\n`;
		}
		md += "\n";
	}

	md += "## Captured Routes\n\n";
	for (const result of successful) {
		md += `### ${captureLabel(result)}\n\n`;
		md += `**URL:** ${result.url}\n\n`;

		for (const [viewport, formats] of Object.entries(result.screenshots)) {
			md += `#### ${viewport.toUpperCase()} (Screenshots)\n\n`;
			const relPng = path.relative(outputDir, formats.png).replace(/\\/g, "/");
			const relWebp = path
				.relative(outputDir, formats.webp)
				.replace(/\\/g, "/");
			const relJpg = path.relative(outputDir, formats.jpg).replace(/\\/g, "/");
			md += `- PNG (lossless): [View](${relPng})\n`;
			md += `- WebP (optimized): [View](${relWebp})\n`;
			md += `- JPEG (compatible): [View](${relJpg})\n\n`;

			if (result.videos?.[viewport]) {
				md += `**${viewport.toUpperCase()} Videos:**\n\n`;
				const videos = result.videos[viewport];
				const relHigh = path
					.relative(outputDir, videos.high)
					.replace(/\\/g, "/");
				const relMedium = path
					.relative(outputDir, videos.medium)
					.replace(/\\/g, "/");
				const relLow = path.relative(outputDir, videos.low).replace(/\\/g, "/");
				md += `- High Quality (1:1 scale): [Watch](${relHigh})\n`;
				md += `- Medium Quality (0.75x scale): [Watch](${relMedium})\n`;
				md += `- Low Quality (0.5x scale): [Watch](${relLow})\n\n`;
			}
		}

		md += "---\n\n";
	}

	if (failed.length > 0) {
		md += "## Failed Captures\n\n";
		for (const result of failed) {
			md += `- ${captureLabel(result)} (${result.url}): ${result.error}\n`;
		}
	}

	return md;
};

export const generateReports = (
	outputDir: string,
	viewports: ReadonlyArray<ViewportConfig>,
	results: Map<string, CaptureResult>,
): Effect.Effect<void, FileSystemError> =>
	Effect.gen(function* () {
		const resultsArray = Array.from(results.values());
		const failed = resultsArray.filter((r) => !!r.error);
		const skipped = resultsArray.filter(
			(r) => !r.error && r.stateStatus === "skipped",
		);
		const successful = resultsArray.filter(
			(r) => !r.error && r.stateStatus !== "skipped",
		);
		const states = resultsArray.filter((r) => r.state !== undefined);
		// `totalRoutes` counts crawled routes only, so a run with no states
		// reports exactly the number it always did.
		const totalRoutes = resultsArray.length - states.length;

		const report = new CaptureReport({
			timestamp: new Date().toISOString(),
			totalRoutes,
			totalStates: states.length,
			successfulCaptures: successful.length,
			failedCaptures: failed.length,
			skippedStates: skipped.length,
			viewports,
			results: resultsArray.map((result) => ({
				url: result.url,
				route: result.route,
				state: result.state,
				stateStatus: result.stateStatus,
				failedStepIndex: result.failedStepIndex,
				screenshots: Object.keys(result.screenshots),
				hasVideo: !!result.videos,
				error: result.error,
			})),
		});

		const jsonPath = path.join(outputDir, "capture-report.json");
		yield* Effect.tryPromise({
			try: () => fs.writeFile(jsonPath, JSON.stringify(report, null, 2)),
			catch: (error) =>
				new FileSystemError({
					path: jsonPath,
					operation: "writeFile",
					cause: error,
				}),
		});

		const markdown = generateMarkdown(
			outputDir,
			{ totalRoutes, totalStates: states.length },
			successful,
			failed,
			states,
		);
		const mdPath = path.join(outputDir, "REPORT.md");
		yield* Effect.tryPromise({
			try: () => fs.writeFile(mdPath, markdown),
			catch: (error) =>
				new FileSystemError({
					path: mdPath,
					operation: "writeFile",
					cause: error,
				}),
		});

		console.log("\n✓ Reports generated");
	});
