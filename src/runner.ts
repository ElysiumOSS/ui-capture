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
import path from "node:path";
import { Effect } from "effect";
import type { CaptureConfigOverrides } from "./schemas.js";
import { CaptureConfigLive, UICaptureService } from "./service.js";
import { type ParsedArgs, parseArgs } from "./utils/args.js";

const BOOLEAN_FLAGS = [
	"help",
	"video",
	"no-interactions",
	"no-warmup",
	"include-subdomains",
];

export const USAGE = `Usage: ui-capture <url> [options]

Crawl a website and capture full-page screenshots (PNG/WebP/JPEG) and
optional multi-quality videos for every reachable internal route.

Arguments:
  <url>                       Starting URL to crawl

Options:
  --output-dir <path>         Output directory (default: ./ui-captures)
  --max-depth <n>             Maximum crawl depth (default: 2)
  --wait <ms>                 Per-page wait after networkidle (default: 2000)
  --concurrency <n>           Parallel route workers (default: 2)
  --include-subdomains        Crawl subdomains of the starting host
  --allowed-hosts <a,b,...>   Extra allowed hostnames (comma separated)
  --viewports <spec,spec>     Viewport specs as name:WIDTHxHEIGHT
                              (default: desktop:1920x1080,tablet:768x1024,mobile:375x667)
  --hide <sel,sel,...>        CSS selectors to hide before screenshotting
  --menu-selectors <sel,...>  Selectors to click before link discovery
  --video                     Capture videos in addition to screenshots
  --video-duration <ms>       Video duration when --video (default: 10000)
  --no-interactions           Disable scripted scrolling during video
  --no-warmup                 Skip the pre-screenshot warm-up scroll
                              (warm-up triggers lazy-load + scroll-reveal
                              animations so screenshots capture real content)
  --ffmpeg <path>             ffmpeg binary path (default: ffmpeg)
  --help                      Show this message

Examples:
  ui-capture https://example.com
  ui-capture https://example.com --video --max-depth 1 --concurrency 4
  ui-capture https://example.com --viewports desktop:1920x1080,mobile:390x844
`;

export const printUsage = (): void => {
	console.log(USAGE);
};

const parseList = (value: unknown): string[] | undefined => {
	if (typeof value !== "string") return undefined;
	const items = value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return items.length > 0 ? items : undefined;
};

const parseInteger = (value: unknown, label: string): number | undefined => {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new Error(`${label} requires a numeric value`);
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) {
		throw new Error(`${label} must be an integer (got "${value}")`);
	}
	return parsed;
};

const parseViewports = (
	value: unknown,
): CaptureConfigOverrides["viewports"] | undefined => {
	const tokens = parseList(value);
	if (!tokens) return undefined;
	return tokens.map((token) => {
		const match = /^([^:]+):(\d+)x(\d+)$/.exec(token);
		if (!match) {
			throw new Error(
				`Invalid viewport spec "${token}". Expected name:WIDTHxHEIGHT (e.g. desktop:1920x1080).`,
			);
		}
		const [, name, w, h] = match;
		if (name === undefined || w === undefined || h === undefined) {
			throw new Error(`Invalid viewport spec "${token}".`);
		}
		return {
			name,
			width: Number.parseInt(w, 10),
			height: Number.parseInt(h, 10),
		};
	});
};

export interface CliInvocation {
	readonly url: string;
	readonly overrides: CaptureConfigOverrides;
}

export const buildInvocation = (parsed: ParsedArgs): CliInvocation => {
	const url = parsed.positional[0];
	if (!url) {
		throw new Error("Missing required <url> argument.");
	}
	try {
		new URL(url);
	} catch {
		throw new Error(`Invalid URL: "${url}"`);
	}

	const opts = parsed.options;
	const overrides: CaptureConfigOverrides = {};

	const outputDir = opts["output-dir"];
	overrides.outputDir =
		typeof outputDir === "string"
			? path.resolve(process.cwd(), outputDir)
			: path.join(process.cwd(), "ui-captures");

	const maxDepth = parseInteger(opts["max-depth"], "--max-depth");
	if (maxDepth !== undefined) overrides.maxDepth = maxDepth;

	const wait = parseInteger(opts.wait, "--wait");
	if (wait !== undefined) overrides.waitTime = wait;

	const concurrency = parseInteger(opts.concurrency, "--concurrency");
	if (concurrency !== undefined) overrides.routeConcurrency = concurrency;

	if (opts["include-subdomains"] === true) overrides.includeSubdomains = true;

	const allowedHosts = parseList(opts["allowed-hosts"]);
	if (allowedHosts) overrides.allowedHosts = allowedHosts;

	const viewports = parseViewports(opts.viewports);
	if (viewports) overrides.viewports = viewports;

	const hide = parseList(opts.hide);
	if (hide) overrides.screenshotHideSelectors = hide;

	const menuSelectors = parseList(opts["menu-selectors"]);
	if (menuSelectors) overrides.menuInteractionSelectors = menuSelectors;

	if (opts.video === true) overrides.captureVideo = true;
	if (opts["no-warmup"] === true) overrides.warmupScroll = false;

	const videoDuration = parseInteger(
		opts["video-duration"],
		"--video-duration",
	);
	const noInteractions = opts["no-interactions"] === true;
	if (videoDuration !== undefined || noInteractions) {
		overrides.videoOptions = {
			...(videoDuration !== undefined ? { duration: videoDuration } : {}),
			interactions: !noInteractions,
		};
	}

	if (typeof opts.ffmpeg === "string") {
		overrides.ffmpegPath = opts.ffmpeg;
	}

	return { url, overrides };
};

export const parseCliArgs = (argv: readonly string[]): ParsedArgs =>
	parseArgs([...argv], BOOLEAN_FLAGS);

export const runFromArgs = async (argv: readonly string[]): Promise<void> => {
	const parsed = parseCliArgs(argv);

	if (parsed.options.help === true || argv.length === 0) {
		printUsage();
		if (argv.length === 0) process.exit(1);
		return;
	}

	let invocation: CliInvocation;
	try {
		invocation = buildInvocation(parsed);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		console.error("\nRun with --help for usage.");
		process.exit(1);
	}

	const program = Effect.gen(function* () {
		const service = yield* UICaptureService;
		return yield* service.captureWebsite(invocation.url);
	}).pipe(
		Effect.provide(UICaptureService.Default),
		Effect.provide(CaptureConfigLive(invocation.overrides)),
	);

	try {
		await Effect.runPromise(program);
	} catch (error) {
		console.error(error);
		process.exit(1);
	}
};
