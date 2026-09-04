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
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateReports } from "./report.js";
import { CaptureResult, ScreenshotPaths, ViewportConfig } from "./schemas.js";

const VIEWPORTS = [
	new ViewportConfig({ name: "desktop", width: 1920, height: 1080 }),
];

let outDir: string;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
	outDir = await fs.mkdtemp(path.join(os.tmpdir(), "uic-report-"));
	log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
	log.mockRestore();
	await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
});

const shots = (dir: string) =>
	new ScreenshotPaths({
		png: path.join(outDir, dir, "screenshots", "png", "desktop_latest.png"),
		webp: path.join(outDir, dir, "screenshots", "webp", "desktop_latest.webp"),
		jpg: path.join(outDir, dir, "screenshots", "jpg", "desktop_latest.jpg"),
	});

const routeResult = (route: string) =>
	new CaptureResult({
		url: `https://example.com/${route === "root" ? "" : route}`,
		route,
		screenshots: { desktop: shots(route) },
		timestamp: 1,
	});

const capturedState = (route: string, state: string) =>
	new CaptureResult({
		url: "https://example.com/",
		route,
		state,
		stateStatus: "captured",
		screenshots: { desktop: shots(path.join(route, "states", state)) },
		timestamp: 1,
	});

const failedState = (route: string, state: string, stepIndex: number) =>
	new CaptureResult({
		url: "https://example.com/",
		route,
		state,
		stateStatus: "failed",
		failedStepIndex: stepIndex,
		screenshots: {},
		error:
			stepIndex < 0
				? `state "${state}" timed out after 30000ms before its first step completed`
				: `state "${state}" failed at step ${stepIndex} (waitFor ".fleet-row"): never became visible within 30000ms`,
		timestamp: 1,
	});

const skippedState = (route: string, state: string) =>
	new CaptureResult({
		url: "https://example.com/",
		route,
		state,
		stateStatus: "skipped",
		screenshots: {},
		timestamp: 1,
	});

const write = async (results: readonly CaptureResult[]) => {
	const map = new Map<string, CaptureResult>(
		results.map((result, index) => [
			result.state ? `${result.route}::state=${result.state}` : `${index}`,
			result,
		]),
	);
	await Effect.runPromise(generateReports(outDir, VIEWPORTS, map));
	return {
		json: JSON.parse(
			await fs.readFile(path.join(outDir, "capture-report.json"), "utf8"),
		),
		md: await fs.readFile(path.join(outDir, "REPORT.md"), "utf8"),
	};
};

describe("generateReports — no scripted states (backwards compatibility)", () => {
	it("counts every result as a route and adds no state sections", async () => {
		const { json, md } = await write([
			routeResult("root"),
			routeResult("about"),
			routeResult("contact"),
		]);
		expect(json.totalRoutes).toBe(3);
		expect(json.totalStates).toBe(0);
		expect(json.skippedStates).toBe(0);
		expect(json.successfulCaptures).toBe(3);
		expect(json.failedCaptures).toBe(0);
		// Every pre-feature field keeps its pre-feature meaning.
		expect(json.successfulCaptures).toBe(json.totalRoutes);
		expect(md).not.toContain("## Scripted States");
		expect(md).not.toContain("Scripted States:");
		expect(md).toContain("- Total Routes: 3");
		// Headings stay bare route names when nothing is scripted.
		expect(md).toContain("### root");
		expect(md).not.toContain("—");
	});

	it("records a route that failed rather than dropping it", async () => {
		const { json, md } = await write([
			routeResult("root"),
			new CaptureResult({
				url: "https://example.com/broken",
				route: "broken",
				screenshots: {},
				error: "Failed to navigate",
				timestamp: 1,
			}),
		]);
		expect(json.totalRoutes).toBe(2);
		expect(json.failedCaptures).toBe(1);
		expect(json.successfulCaptures).toBe(1);
		expect(md).toContain("## Failed Captures");
		expect(md).toContain("Failed to navigate");
	});
});

describe("generateReports — scripted states", () => {
	it("keeps states out of totalRoutes and counts them separately", async () => {
		const { json } = await write([
			routeResult("root"),
			capturedState("root", "spawn-dialog"),
			capturedState("root", "fleet-editor"),
		]);
		expect(json.totalRoutes).toBe(1);
		expect(json.totalStates).toBe(2);
		expect(json.successfulCaptures).toBe(3);
	});

	it("records a failed state with a machine-readable step index", async () => {
		const { json, md } = await write([
			routeResult("root"),
			capturedState("root", "spawn-dialog"),
			failedState("root", "fleet-editor", 3),
		]);
		expect(json.failedCaptures).toBe(1);
		expect(json.totalStates).toBe(2);

		const entry = json.results.find(
			(result: { state?: string }) => result.state === "fleet-editor",
		);
		expect(entry.stateStatus).toBe("failed");
		expect(entry.failedStepIndex).toBe(3);
		expect(entry.screenshots).toEqual([]);
		expect(entry.error).toContain("never became visible");

		// The failure is visible in all three of the report's surfaces.
		expect(md).toContain("## Scripted States");
		expect(md).toContain("| fleet-editor | root |");
		expect(md).toContain("✗ failed");
		expect(md).toContain("step 3");
		expect(md).toContain("## Failed Captures");
		expect(md).toContain("root — fleet-editor");

		// And the sibling state still reports as captured: one broken state does
		// not contaminate the run.
		expect(md).toContain("✓ captured");
		expect(md).toContain("### root — spawn-dialog");
	});

	it("uses -1 for a whole-state failure and prints no step number", async () => {
		const { json, md } = await write([failedState("root", "hung", -1)]);
		expect(
			json.results.find((r: { state?: string }) => r.state === "hung")
				.failedStepIndex,
		).toBe(-1);
		expect(md).toContain(
			"| hung | root | https://example.com/ | ✗ failed |  |",
		);
		expect(md).not.toContain("step -1");
	});

	it("separates a skipped precondition from a broken script", async () => {
		const { json, md } = await write([
			routeResult("root"),
			skippedState("root", "safety-advanced"),
			failedState("root", "fleet-editor", 1),
		]);
		expect(json.skippedStates).toBe(1);
		expect(json.failedCaptures).toBe(1);
		// A skip is neither a success nor a failure.
		expect(json.successfulCaptures).toBe(1);
		expect(md).toContain("– skipped");
	});

	it("does not let a state result overwrite the route result for its URL", async () => {
		const { json } = await write([
			routeResult("root"),
			capturedState("root", "spawn-dialog"),
		]);
		expect(json.results).toHaveLength(2);
		expect(
			json.results.filter((r: { state?: string }) => !r.state),
		).toHaveLength(1);
	});
});
