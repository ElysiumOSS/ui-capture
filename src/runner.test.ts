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
	it("leaves the color scheme unset so the default applies", () => {
		const inv = buildInvocation(parseCliArgs(["https://example.com"]));
		expect(inv.overrides.colorScheme).toBeUndefined();
	});

	it("accepts each supported color scheme", () => {
		for (const scheme of ["light", "dark", "no-preference"] as const) {
			const inv = buildInvocation(
				parseCliArgs(["https://example.com", "--color-scheme", scheme]),
			);
			expect(inv.overrides.colorScheme).toBe(scheme);
		}
	});

	it("rejects a color scheme Playwright would not accept", () => {
		expect(() =>
			buildInvocation(
				parseCliArgs(["https://example.com", "--color-scheme", "midnight"]),
			),
		).toThrow(/Invalid --color-scheme/);
	});

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

describe("buildInvocation scripted-state flags", () => {
	it("leaves every state field untouched when no flag is passed", () => {
		const inv = buildInvocation(parseCliArgs(["https://example.com"]));
		expect(inv.statesPath).toBeUndefined();
		expect(inv.stateFilter).toBeUndefined();
		expect(inv.failOnStateError).toBe(false);
		expect(inv.overrides.states).toBeUndefined();
		expect(inv.overrides.captureRoutes).toBeUndefined();
		expect(inv.overrides.stateTimeout).toBeUndefined();
		expect(inv.overrides.allowStateRequests).toBeUndefined();
	});

	it("resolves --states against cwd and keeps parsing I/O-free", () => {
		const inv = buildInvocation(
			parseCliArgs(["https://example.com", "--states", "./states.json"]),
		);
		expect(inv.statesPath).toBe(path.resolve(process.cwd(), "states.json"));
		expect(inv.overrides.states).toBeUndefined();
	});

	it("carries the state flags into overrides", () => {
		const inv = buildInvocation(
			parseCliArgs([
				"https://example.com",
				"--states",
				"./states.json",
				"--state-filter",
				"fleet-editor, spawn-dialog",
				"--skip-routes",
				"--state-timeout",
				"45000",
				"--allow-state-requests",
				"--fail-on-state-error",
			]),
		);
		expect(inv.stateFilter).toEqual(["fleet-editor", "spawn-dialog"]);
		expect(inv.overrides.captureRoutes).toBe(false);
		expect(inv.overrides.stateTimeout).toBe(45000);
		expect(inv.overrides.allowStateRequests).toBe(true);
		expect(inv.failOnStateError).toBe(true);
	});

	it("rejects flags that would capture nothing or filter nothing", () => {
		expect(() =>
			buildInvocation(
				parseCliArgs(["https://example.com", "--state-filter", "a"]),
			),
		).toThrow(/--state-filter requires --states/);
		expect(() =>
			buildInvocation(parseCliArgs(["https://example.com", "--skip-routes"])),
		).toThrow(/--skip-routes requires --states/);
	});
});

describe("USAGE scripted states", () => {
	it("documents every scripted-state flag", () => {
		expect(USAGE).toContain("--states <path>");
		expect(USAGE).toContain("--state-filter");
		expect(USAGE).toContain("--skip-routes");
		expect(USAGE).toContain("--state-timeout");
		expect(USAGE).toContain("--precondition-timeout");
		expect(USAGE).toContain("--allow-state-requests");
		expect(USAGE).toContain("--fail-on-state-error");
	});
});

describe("buildInvocation scripted-state flags — parsing edge cases", () => {
	it("carries --precondition-timeout into overrides", () => {
		const inv = buildInvocation(
			parseCliArgs([
				"https://example.com",
				"--states",
				"./states.json",
				"--precondition-timeout",
				"25000",
			]),
		);
		expect(inv.overrides.preconditionTimeout).toBe(25000);
	});

	it("leaves preconditionTimeout unset when the flag is absent", () => {
		const inv = buildInvocation(parseCliArgs(["https://example.com"]));
		expect(inv.overrides.preconditionTimeout).toBeUndefined();
	});

	it("rejects a non-numeric --precondition-timeout", () => {
		expect(() =>
			buildInvocation(
				parseCliArgs([
					"https://example.com",
					"--precondition-timeout",
					"later",
				]),
			),
		).toThrow(/--precondition-timeout must be an integer/);
	});

	it("rejects a non-numeric --state-timeout", () => {
		expect(() =>
			buildInvocation(
				parseCliArgs(["https://example.com", "--state-timeout", "soon"]),
			),
		).toThrow(/--state-timeout must be an integer/);
	});

	it("accepts the --states=<path> form", () => {
		const inv = buildInvocation(
			parseCliArgs(["https://example.com", "--states=./ui.states.json"]),
		);
		expect(inv.statesPath).toBe(path.resolve(process.cwd(), "ui.states.json"));
	});

	it("treats a states path that looks like a flag as a value", () => {
		// --states is a VALUE_FLAG, so the next token is swallowed verbatim
		// rather than parsed as another option.
		const inv = buildInvocation(
			parseCliArgs(["https://example.com", "--states", "--odd-name.json"]),
		);
		expect(inv.statesPath).toBe(path.resolve(process.cwd(), "--odd-name.json"));
	});

	it("keeps boolean state flags from swallowing the following flag", () => {
		const inv = buildInvocation(
			parseCliArgs([
				"https://example.com",
				"--skip-routes",
				"--allow-state-requests",
				"--fail-on-state-error",
				"--states",
				"s.json",
			]),
		);
		expect(inv.overrides.captureRoutes).toBe(false);
		expect(inv.overrides.allowStateRequests).toBe(true);
		expect(inv.failOnStateError).toBe(true);
		expect(inv.statesPath).toBe(path.resolve(process.cwd(), "s.json"));
	});

	it("permits the request gate and the CI gate without a states file", () => {
		// Neither changes what is captured on its own, so neither is worth an
		// error; only --state-filter and --skip-routes are meaningless alone.
		const inv = buildInvocation(
			parseCliArgs([
				"https://example.com",
				"--allow-state-requests",
				"--fail-on-state-error",
			]),
		);
		expect(inv.overrides.allowStateRequests).toBe(true);
		expect(inv.failOnStateError).toBe(true);
		expect(inv.overrides.captureRoutes).toBeUndefined();
	});

	it("trims and drops empty entries in --state-filter", () => {
		const inv = buildInvocation(
			parseCliArgs([
				"https://example.com",
				"--states",
				"s.json",
				"--state-filter",
				" a , ,b ",
			]),
		);
		expect(inv.stateFilter).toEqual(["a", "b"]);
	});
});

describe("buildInvocation backwards compatibility", () => {
	it("adds no scripted-state key to overrides for a pre-feature invocation", () => {
		// The feature is additive: a call written before it existed must produce
		// byte-identical config, which means the override object must not gain
		// keys that would shadow a CaptureConfig default.
		const inv = buildInvocation(
			parseCliArgs([
				"https://example.com",
				"--video",
				"--max-depth",
				"1",
				"--concurrency",
				"4",
				"--viewports",
				"desktop:1920x1080",
				"--no-warmup",
			]),
		);
		const stateKeys = [
			"states",
			"stateTimeout",
			"captureRoutes",
			"allowStateRequests",
		];
		for (const key of stateKeys) {
			expect(Object.hasOwn(inv.overrides, key)).toBe(false);
		}
		expect(inv.statesPath).toBeUndefined();
		expect(inv.stateFilter).toBeUndefined();
	});
});
