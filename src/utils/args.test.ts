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
import { parseArgs } from "./args.js";

describe("parseArgs", () => {
	it("collects bare positional arguments", () => {
		const result = parseArgs(["https://example.com", "extra"]);
		expect(result.positional).toEqual(["https://example.com", "extra"]);
		expect(result.options).toEqual({});
	});

	it("parses `--key value` pairs", () => {
		const result = parseArgs(["--output-dir", "out", "--max-depth", "2"]);
		expect(result.options).toEqual({ "output-dir": "out", "max-depth": "2" });
	});

	it("parses `--key=value` pairs", () => {
		const result = parseArgs(["--ffmpeg=/usr/bin/ffmpeg", "--wait=1500"]);
		expect(result.options).toEqual({
			ffmpeg: "/usr/bin/ffmpeg",
			wait: "1500",
		});
	});

	it("treats declared boolean flags as booleans even if a value follows", () => {
		const result = parseArgs(["--video", "https://example.com"], ["video"]);
		expect(result.options.video).toBe(true);
		expect(result.positional).toEqual(["https://example.com"]);
	});

	it("treats trailing standalone flags as boolean true", () => {
		const result = parseArgs(["--include-subdomains"]);
		expect(result.options["include-subdomains"]).toBe(true);
	});

	it("mixes positional and options correctly (CLI usage shape)", () => {
		const result = parseArgs(
			[
				"https://example.com",
				"--max-depth",
				"1",
				"--video",
				"--ffmpeg=/usr/local/bin/ffmpeg",
				"--no-warmup",
			],
			["video", "no-warmup"],
		);
		expect(result.positional).toEqual(["https://example.com"]);
		expect(result.options).toEqual({
			"max-depth": "1",
			video: true,
			ffmpeg: "/usr/local/bin/ffmpeg",
			"no-warmup": true,
		});
	});

	it("returns empty parse for empty argv", () => {
		const result = parseArgs([]);
		expect(result.positional).toEqual([]);
		expect(result.options).toEqual({});
	});
});

describe("parseArgs valueFlags", () => {
	it("consumes a value that itself starts with -- when the flag is declared value-taking", () => {
		const parsed = parseArgs(
			["--launch-args", "--enable-blink-features=CanvasDrawElement"],
			[],
			["launch-args"],
		);
		expect(parsed.options["launch-args"]).toBe(
			"--enable-blink-features=CanvasDrawElement",
		);
		expect(parsed.positional).toEqual([]);
	});

	it("still treats a value-taking flag with no following token as a boolean", () => {
		const parsed = parseArgs(["--launch-args"], [], ["launch-args"]);
		expect(parsed.options["launch-args"]).toBe(true);
	});

	it("leaves undeclared flags on the existing do-not-consume-a-flag behavior", () => {
		const parsed = parseArgs(["--wait", "--video"], ["video"]);
		expect(parsed.options.wait).toBe(true);
		expect(parsed.options.video).toBe(true);
	});
});
