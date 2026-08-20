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

import { describe, expect, it } from "vitest";
import {
	CaptureConfig,
	createCaptureConfig,
	VideoOptions,
	ViewportConfig,
} from "./schemas.js";

describe("createCaptureConfig", () => {
	it("returns the documented defaults when given no overrides", () => {
		const cfg = createCaptureConfig();
		expect(cfg).toBeInstanceOf(CaptureConfig);
		expect(cfg.outputDir).toBe("ui-captures");
		expect(cfg.captureVideo).toBe(false);
		expect(cfg.maxDepth).toBe(2);
		expect(cfg.waitTime).toBe(2000);
		expect(cfg.includeSubdomains).toBe(false);
		expect(cfg.allowedHosts).toEqual([]);
		expect(cfg.routeConcurrency).toBe(2);
		expect(cfg.menuInteractionSelectors).toEqual([]);
		expect(cfg.screenshotHideSelectors).toEqual([]);
		expect(cfg.ffmpegPath).toBe("ffmpeg");
		expect(cfg.warmupScroll).toBe(true);
		expect(cfg.viewports).toHaveLength(3);
		expect(cfg.viewports.map((v) => v.name)).toEqual([
			"desktop",
			"tablet",
			"mobile",
		]);
		expect(cfg.videoOptions.duration).toBe(10000);
		expect(cfg.videoOptions.interactions).toBe(true);
	});

	it("applies scalar overrides without disturbing other defaults", () => {
		const cfg = createCaptureConfig({
			outputDir: "/tmp/out",
			maxDepth: 0,
			captureVideo: true,
			warmupScroll: false,
		});
		expect(cfg.outputDir).toBe("/tmp/out");
		expect(cfg.maxDepth).toBe(0);
		expect(cfg.captureVideo).toBe(true);
		expect(cfg.warmupScroll).toBe(false);
		expect(cfg.waitTime).toBe(2000);
		expect(cfg.routeConcurrency).toBe(2);
	});

	it("normalises plain-object viewport input into ViewportConfig instances", () => {
		const cfg = createCaptureConfig({
			viewports: [
				{ name: "desktop", width: 1920, height: 1080 },
				{ name: "mobile", width: 390, height: 844 },
			],
		});
		expect(cfg.viewports).toHaveLength(2);
		expect(cfg.viewports[0]).toBeInstanceOf(ViewportConfig);
		expect(cfg.viewports[1]?.width).toBe(390);
		expect(cfg.viewports[1]?.height).toBe(844);
	});

	it("merges partial videoOptions on top of defaults", () => {
		const cfg = createCaptureConfig({
			videoOptions: { duration: 15000 },
		});
		expect(cfg.videoOptions).toBeInstanceOf(VideoOptions);
		expect(cfg.videoOptions.duration).toBe(15000);
		expect(cfg.videoOptions.interactions).toBe(true);
	});

	it("disables interactions while preserving duration default", () => {
		const cfg = createCaptureConfig({
			videoOptions: { interactions: false },
		});
		expect(cfg.videoOptions.duration).toBe(10000);
		expect(cfg.videoOptions.interactions).toBe(false);
	});

	it("copies array overrides defensively (no shared references)", () => {
		const allowed = ["app.example.com", "api.example.com"] as const;
		const hide = [".cookie-banner"] as const;
		const cfg = createCaptureConfig({
			allowedHosts: allowed,
			screenshotHideSelectors: hide,
		});
		expect(cfg.allowedHosts).toEqual([...allowed]);
		expect(cfg.allowedHosts).not.toBe(allowed);
		expect(cfg.screenshotHideSelectors).toEqual([...hide]);
	});
});

describe("createCaptureConfig launchArgs", () => {
	it("defaults to no extra launch args", () => {
		expect(createCaptureConfig().launchArgs).toEqual([]);
	});

	it("carries extra Chromium flags through as a mutable copy", () => {
		const input = ["--enable-blink-features=CanvasDrawElement"] as const;
		const cfg = createCaptureConfig({ launchArgs: input });
		expect(cfg.launchArgs).toEqual([
			"--enable-blink-features=CanvasDrawElement",
		]);
		expect(cfg.launchArgs).not.toBe(input);
	});
});
