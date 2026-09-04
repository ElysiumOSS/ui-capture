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
import type { CaptureConfigOverrides, CaptureState } from "./schemas.js";
import { CaptureConfigLive, UICaptureService } from "./service.js";
import { filterStates, parseStatesFile, statesUseRequests } from "./states.js";
import { type ParsedArgs, parseArgs } from "./utils/args.js";

const BOOLEAN_FLAGS = [
	"help",
	"video",
	"no-interactions",
	"no-warmup",
	"include-subdomains",
	"skip-routes",
	"allow-state-requests",
	"fail-on-state-error",
];

/**
 * Options whose value is allowed to look like a flag. Chromium switches start
 * with `--`, so the parser has to be told not to mistake them for options.
 */
const VALUE_FLAGS = ["launch-args", "states", "state-filter"];

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
                              (this opens menus so links become discoverable;
                              it is not a capture-state mechanism — see
                              --states for that)
  --states <path>             JSON file of named interaction scripts. Each
                              named state is performed on a fresh page load
                              and yields its own capture set, so a single-route
                              app's dialogs and workspaces get captured too.
  --state-filter <a,b,...>    Run only these named states (default: all)
  --skip-routes               Capture only scripted states, not crawled routes
  --state-timeout <ms>        Per-state budget covering navigation, script and
                              capture (default: 30000; a state may override it)
  --allow-state-requests      Permit request steps, which reach past the UI
                              into the app's own backend. Off by default: a
                              states file from a colleague should not be able
                              to POST to your app because you ran the tool.
  --fail-on-state-error       Exit non-zero when any scripted state failed
  --video                     Capture videos in addition to screenshots
  --video-duration <ms>       Video duration when --video (default: 10000)
  --no-interactions           Disable scripted scrolling during video
  --color-scheme <scheme>     prefers-color-scheme to report: light, dark, or
                              no-preference (default: light). A site that
                              follows the OS theme renders light under headless
                              Chromium, so pass dark to capture its dark face.
  --no-warmup                 Skip the pre-screenshot warm-up scroll
                              (warm-up triggers lazy-load + scroll-reveal
                              animations so screenshots capture real content)
  --ffmpeg <path>             ffmpeg binary path (default: ffmpeg)
  --launch-args <args>        Extra Chromium switches, whitespace separated
                              (e.g. to enable an experimental web platform
                              feature the captured page depends on)
  --help                      Show this message

Examples:
  ui-capture https://example.com
  ui-capture https://example.com --video --max-depth 1 --concurrency 4
  ui-capture https://example.com --viewports desktop:1920x1080,mobile:390x844
  ui-capture https://example.com --hide ".cookie-banner,#chat-widget"
  ui-capture https://example.com --color-scheme dark
  ui-capture https://example.com --launch-args "--enable-blink-features=CanvasDrawElement"
  ui-capture http://localhost:5173 --max-depth 0 --states ./ui-capture.states.json
  ui-capture http://localhost:5173 --states ./states.json --state-filter fleet-editor
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

/**
 * Chromium switches are whitespace separated rather than comma separated: a
 * single switch may itself contain commas (`--enable-blink-features=A,B`).
 */
const parseLaunchArgs = (value: unknown): string[] | undefined => {
	if (typeof value !== "string") return undefined;
	const items = value.split(/\s+/).filter(Boolean);
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
	/**
	 * Resolved path of a states file, if any. `buildInvocation` stays
	 * synchronous and I/O-free — its whole unit-test surface depends on that —
	 * so reading and parsing happens in `runFromArgs`, at the edge.
	 */
	readonly statesPath?: string;
	readonly stateFilter?: ReadonlyArray<string>;
	readonly failOnStateError: boolean;
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

	const colorScheme = opts["color-scheme"];
	if (colorScheme !== undefined) {
		if (
			colorScheme !== "light" &&
			colorScheme !== "dark" &&
			colorScheme !== "no-preference"
		) {
			throw new Error(
				`Invalid --color-scheme "${String(colorScheme)}". Expected light, dark, or no-preference.`,
			);
		}
		overrides.colorScheme = colorScheme;
	}

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

	const launchArgs = parseLaunchArgs(opts["launch-args"]);
	if (launchArgs) overrides.launchArgs = launchArgs;

	if (opts["skip-routes"] === true) overrides.captureRoutes = false;
	if (opts["allow-state-requests"] === true) {
		overrides.allowStateRequests = true;
	}

	const stateTimeout = parseInteger(opts["state-timeout"], "--state-timeout");
	if (stateTimeout !== undefined) overrides.stateTimeout = stateTimeout;

	const statesOpt = opts.states;
	const statesPath =
		typeof statesOpt === "string"
			? path.resolve(process.cwd(), statesOpt)
			: undefined;
	const stateFilter = parseList(opts["state-filter"]);

	if (statesPath === undefined && stateFilter) {
		throw new Error("--state-filter requires --states.");
	}
	if (statesPath === undefined && opts["skip-routes"] === true) {
		throw new Error(
			"--skip-routes requires --states; nothing would be captured.",
		);
	}

	return {
		url,
		overrides,
		...(statesPath !== undefined ? { statesPath } : {}),
		...(stateFilter ? { stateFilter } : {}),
		failOnStateError: opts["fail-on-state-error"] === true,
	};
};

/**
 * Reads and parses a states file. Kept separate from `buildInvocation` so flag
 * parsing stays pure, and separate from the service so a decode failure is
 * reported before Chromium launches.
 */
const loadStates = async (
	invocation: CliInvocation,
): Promise<ReadonlyArray<CaptureState>> => {
	if (invocation.statesPath === undefined) return [];
	const contents = await fs.readFile(invocation.statesPath, "utf8");
	const parsed = parseStatesFile(contents, invocation.statesPath);
	const selected = invocation.stateFilter
		? filterStates(parsed, invocation.stateFilter)
		: parsed;
	if (
		statesUseRequests(selected) &&
		invocation.overrides.allowStateRequests !== true
	) {
		throw new Error(
			"This states file contains `request` steps, which reach past the UI into the app's own backend. Re-run with --allow-state-requests if that is what you want.",
		);
	}
	return selected;
};

export const parseCliArgs = (argv: readonly string[]): ParsedArgs =>
	parseArgs([...argv], BOOLEAN_FLAGS, VALUE_FLAGS);

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

	let states: ReadonlyArray<CaptureState>;
	try {
		states = await loadStates(invocation);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		console.error("\nRun with --help for usage.");
		process.exit(1);
	}

	const overrides: CaptureConfigOverrides =
		states.length > 0
			? { ...invocation.overrides, states }
			: invocation.overrides;

	const program = Effect.gen(function* () {
		const service = yield* UICaptureService;
		return yield* service.captureWebsite(invocation.url);
	}).pipe(
		Effect.provide(UICaptureService.Default),
		Effect.provide(CaptureConfigLive(overrides)),
	);

	try {
		const results = await Effect.runPromise(program);
		const failedStates = Array.from(results.values()).filter(
			(result) => result.stateStatus === "failed",
		);
		if (invocation.failOnStateError && failedStates.length > 0) {
			console.error(
				`\n${failedStates.length} scripted state(s) failed: ${failedStates
					.map((result) => result.state)
					.join(", ")}`,
			);
			process.exit(1);
		}
	} catch (error) {
		console.error(error);
		process.exit(1);
	}
};
