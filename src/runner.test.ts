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

import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildInvocation, parseCliArgs, USAGE } from "./runner.js";

describe("USAGE", () => {
	it("documents the program name and key flags", () => {
		expect(USAGE).toMatch(/^Usage: ui-capture <url>/);
		expect(USAGE).toContain("--max-depth");
		expect(USAGE).toContain("--video");
		expect(USAGE).toContain("--no-warmup");
		expect(USAGE).toContain("--viewports");
	});
});

describe("parseCliArgs", () => {
	it("treats known boolean flags as booleans", () => {
		const parsed = parseCliArgs([
			"https://example.com",
			"--video",
			"--no-warmup",
			"--include-subdomains",
		]);
		expect(parsed.options.video).toBe(true);
		expect(parsed.options["no-warmup"]).toBe(true);
		expect(parsed.options["include-subdomains"]).toBe(true);
		expect(parsed.positional).toEqual(["https://example.com"]);
	});
});

describe("buildInvocation", () => {
	const cwd = process.cwd();

	it("rejects calls without a positional URL", () => {
		expect(() => buildInvocation(parseCliArgs([]))).toThrow(
			/Missing required <url>/,
		);
	});

	it("rejects an invalid URL", () => {
		expect(() => buildInvocation(parseCliArgs(["not-a-url"]))).toThrow(
			/Invalid URL/,
		);
	});

	it("returns the URL and a default-resolved outputDir for a bare CLI call", () => {
		const inv = buildInvocation(parseCliArgs(["https://example.com"]));
		expect(inv.url).toBe("https://example.com");
		expect(inv.overrides.outputDir).toBe(path.join(cwd, "ui-captures"));
	});

	it("resolves a relative --output-dir against cwd", () => {
		const inv = buildInvocation(
			parseCliArgs(["https://example.com", "--output-dir", "out/screenshots"]),
		);
		expect(inv.overrides.outputDir).toBe(path.resolve(cwd, "out/screenshots"));
	});

	it("parses integer flags into numbers", () => {
		const inv = buildInvocation(
			parseCliArgs([
				"https://example.com",
				"--max-depth",
				"3",
				"--wait",
				"1500",
				"--concurrency",
				"4",
			]),
		);
		expect(inv.overrides.maxDepth).toBe(3);
		expect(inv.overrides.waitTime).toBe(1500);
		expect(inv.overrides.routeConcurrency).toBe(4);
	});

	it("parses comma-separated viewport specs", () => {
		const inv = buildInvocation(
			parseCliArgs([
				"https://example.com",
				"--viewports",
				"desktop:1920x1080,mobile:390x844",
			]),
		);
		expect(inv.overrides.viewports).toEqual([
			{ name: "desktop", width: 1920, height: 1080 },
			{ name: "mobile", width: 390, height: 844 },
		]);
	});

	it("rejects malformed viewport specs", () => {
		expect(() =>
			buildInvocation(
				parseCliArgs(["https://example.com", "--viewports", "bogus"]),
			),
		).toThrow(/Invalid viewport spec/);
	});

	it("parses comma-separated list flags", () => {
		const inv = buildInvocation(
			parseCliArgs([
				"https://example.com",
				"--allowed-hosts",
				"a.example.com,b.example.com",
				"--hide",
				".cookie-banner,#chat-widget",
				"--menu-selectors",
				"button[data-nav-toggle],[data-open-menu]",
			]),
		);
		expect(inv.overrides.allowedHosts).toEqual([
			"a.example.com",
			"b.example.com",
		]);
		expect(inv.overrides.screenshotHideSelectors).toEqual([
			".cookie-banner",
			"#chat-widget",
		]);
		expect(inv.overrides.menuInteractionSelectors).toEqual([
			"button[data-nav-toggle]",
			"[data-open-menu]",
		]);
	});

	it("wires --video, --video-duration, --no-interactions into videoOptions", () => {
		const inv = buildInvocation(
			parseCliArgs([
				"https://example.com",
				"--video",
				"--video-duration",
				"15000",
				"--no-interactions",
			]),
		);
		expect(inv.overrides.captureVideo).toBe(true);
		expect(inv.overrides.videoOptions).toEqual({
			duration: 15000,
			interactions: false,
		});
	});

	it("wires --no-warmup into warmupScroll=false", () => {
		const inv = buildInvocation(
			parseCliArgs(["https://example.com", "--no-warmup"]),
		);
		expect(inv.overrides.warmupScroll).toBe(false);
	});

	it("wires --include-subdomains and --ffmpeg through to overrides", () => {
		const inv = buildInvocation(
			parseCliArgs([
				"https://example.com",
				"--include-subdomains",
				"--ffmpeg",
				"/usr/local/bin/ffmpeg",
			]),
		);
		expect(inv.overrides.includeSubdomains).toBe(true);
		expect(inv.overrides.ffmpegPath).toBe("/usr/local/bin/ffmpeg");
	});

	it("rejects non-numeric --max-depth", () => {
		expect(() =>
			buildInvocation(
				parseCliArgs(["https://example.com", "--max-depth", "abc"]),
			),
		).toThrow(/--max-depth must be an integer/);
	});

	it("matches the README CLI example end-to-end", () => {
		// `ui-capture https://example.com --video --max-depth 1 --concurrency 4`
		const inv = buildInvocation(
			parseCliArgs([
				"https://example.com",
				"--video",
				"--max-depth",
				"1",
				"--concurrency",
				"4",
			]),
		);
		expect(inv.url).toBe("https://example.com");
		expect(inv.overrides.captureVideo).toBe(true);
		expect(inv.overrides.maxDepth).toBe(1);
		expect(inv.overrides.routeConcurrency).toBe(4);
	});
});

describe("buildInvocation --launch-args", () => {
	it("omits launchArgs when the flag is absent", () => {
		const inv = buildInvocation(parseCliArgs(["https://example.com"]));
		expect(inv.overrides.launchArgs).toBeUndefined();
	});

	it("splits a whitespace-separated flag string into individual args", () => {
		const inv = buildInvocation(
			parseCliArgs([
				"https://example.com",
				"--launch-args",
				"--enable-blink-features=CanvasDrawElement --use-gl=angle",
			]),
		);
		expect(inv.overrides.launchArgs).toEqual([
			"--enable-blink-features=CanvasDrawElement",
			"--use-gl=angle",
		]);
	});

	it("preserves commas inside a single Chromium flag value", () => {
		const inv = buildInvocation(
			parseCliArgs([
				"https://example.com",
				"--launch-args=--enable-blink-features=CanvasDrawElement,CanvasPlaceElement",
			]),
		);
		expect(inv.overrides.launchArgs).toEqual([
			"--enable-blink-features=CanvasDrawElement,CanvasPlaceElement",
		]);
	});
});

describe("USAGE launch args", () => {
	it("documents --launch-args", () => {
		expect(USAGE).toContain("--launch-args");
	});
});
