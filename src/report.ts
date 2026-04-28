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

const generateMarkdown = (
	outputDir: string,
	results: Map<string, CaptureResult>,
	successful: CaptureResult[],
	failed: CaptureResult[],
): string => {
	let md = "# UI Capture Report\n\n";
	md += `Generated: ${new Date().toISOString()}\n\n`;
	md += "## Summary\n\n";
	md += `- Total Routes: ${results.size}\n`;
	md += `- Successful: ${successful.length}\n`;
	md += `- Failed: ${failed.length}\n\n`;

	md += "## Captured Routes\n\n";
	for (const result of successful) {
		md += `### ${result.route}\n\n`;
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
			md += `- ${result.url}: ${result.error}\n`;
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
		const successful = resultsArray.filter((r) => !r.error);
		const failed = resultsArray.filter((r) => !!r.error);

		const report = new CaptureReport({
			timestamp: new Date().toISOString(),
			totalRoutes: results.size,
			successfulCaptures: successful.length,
			failedCaptures: failed.length,
			viewports,
			results: resultsArray.map((result) => ({
				url: result.url,
				route: result.route,
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

		const markdown = generateMarkdown(outputDir, results, successful, failed);
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
