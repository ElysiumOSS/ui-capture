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
import { Effect, Option } from "effect";
import type { Page } from "playwright";
import { CaptureError } from "./errors.js";
import { LINK_FILTER_CONCURRENCY } from "./shared.js";

const ASSET_EXTENSIONS = new Set<string>([
	// stylesheets / scripts / data
	"css", "js", "mjs", "cjs", "map", "json", "xml", "webmanifest", "txt", "csv",
	// images
	"png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "bmp", "tiff",
	// media
	"mp4", "webm", "mov", "avi", "mkv", "mp3", "wav", "ogg", "flac", "m4a",
	// fonts
	"woff", "woff2", "ttf", "otf", "eot",
	// archives / docs
	"pdf", "zip", "tar", "gz", "tgz", "bz2", "7z", "rar",
]);

const isAssetUrl = (pathname: string): boolean => {
	const lastDot = pathname.lastIndexOf(".");
	if (lastDot < 0) return false;
	const ext = pathname.slice(lastDot + 1).toLowerCase();
	return ASSET_EXTENSIONS.has(ext);
};

export interface LinkDiscoveryTools {
	readonly prepareForLinkDiscovery: (
		page: Page,
		url: string,
	) => Effect.Effect<void, CaptureError>;
	readonly extractLinks: (
		page: Page,
	) => Effect.Effect<readonly string[], never>;
}

export const createLinkDiscoveryTools = (options: {
	readonly hostMatchesFilters: (hostname: string) => boolean;
	readonly menuInteractionSelectors: ReadonlyArray<string>;
}): LinkDiscoveryTools => {
	const { hostMatchesFilters, menuInteractionSelectors } = options;
	const interactionSelectors = menuInteractionSelectors.filter(
		(selector) => !!selector?.trim(),
	);

	const prepareForLinkDiscovery = (
		page: Page,
		url: string,
	): Effect.Effect<void, CaptureError> =>
		Effect.tryPromise({
			try: async () => {
				await page.evaluate(async (selectors: string[]) => {
					const safeClick = (element: Element) => {
						if (!(element instanceof HTMLElement)) return;
						const tag = element.tagName.toLowerCase();
						if (element.hasAttribute("href") || tag === "a") return;
						if (typeof element.click === "function") {
							element.click();
						} else {
							element.dispatchEvent(
								new MouseEvent("click", { bubbles: true, cancelable: true }),
							);
						}
					};

					document.querySelectorAll("details").forEach((detail) => {
						if (!detail.open) detail.open = true;
					});

					document.querySelectorAll("summary").forEach((summary) => {
						safeClick(summary);
					});

					selectors.forEach((selector) => {
						if (!selector) return;
						const elements = Array.from(
							document.querySelectorAll(selector),
						).slice(0, 10);
						elements.forEach((element) => safeClick(element));
					});

					window.scrollTo({
						top: document.body.scrollHeight,
						behavior: "smooth",
					});
					await new Promise((resolve) => setTimeout(resolve, 150));
					window.scrollTo({ top: 0, behavior: "smooth" });
				}, interactionSelectors);
			},
			catch: (error) =>
				new CaptureError({
					url,
					message: "Failed to prepare page for link discovery",
					cause: error,
				}),
		});

	const extractLinks = (page: Page): Effect.Effect<readonly string[], never> =>
		Effect.tryPromise({
			try: async () => {
				return await page.evaluate(() => {
					const normalize = (
						value: string | null | undefined,
					): string | null => {
						if (!value) return null;
						const trimmed = value.trim();
						if (
							!trimmed ||
							trimmed === "#" ||
							trimmed.startsWith("javascript:") ||
							trimmed.startsWith("mailto:") ||
							trimmed.startsWith("tel:")
						) {
							return null;
						}
						try {
							const absolute = new URL(trimmed, window.location.href);
							absolute.hash = "";
							return absolute.href;
						} catch {
							return null;
						}
					};

					const addValue = (
						candidate: string | null | undefined,
						into: Set<string>,
					) => {
						const normalized = normalize(candidate);
						if (normalized) into.add(normalized);
					};

					const discovered = new Set<string>();
					const anchorElements = Array.from(
						document.querySelectorAll("a[href], area[href]"),
					);
					anchorElements.forEach((element) => {
						const href =
							element.getAttribute("href") ??
							(element as HTMLAnchorElement).href;
						addValue(href, discovered);
					});

					const attributeNames = [
						"data-href",
						"data-url",
						"data-route",
						"data-path",
						"data-link",
						"data-target",
						"routerLink",
						"routerlink",
						"to",
						"href",
					];
					const attributeSelector = attributeNames
						.map((name) => `[${name}]`)
						.join(",");

					if (attributeSelector) {
						const nodes = Array.from(
							document.querySelectorAll(attributeSelector),
						);
						nodes.forEach((node) => {
							if (!(node instanceof HTMLElement)) return;
							attributeNames.forEach((attribute) => {
								const value =
									node.getAttribute(attribute) ??
									((node as unknown as Record<string, unknown>)[attribute] as
										| string
										| undefined);
								if (!value) return;
								value
									.split(/[\s,]+/)
									.filter(Boolean)
									.forEach((token) => addValue(token, discovered));
							});
						});
					}

					const collectFromObject = (
						value: unknown,
						into: Set<string>,
						depth = 0,
						limit = { count: 0 },
					) => {
						if (!value || depth > 4 || limit.count > 500) return;
						if (typeof value === "string") {
							limit.count += 1;
							addValue(value, into);
							return;
						}
						if (Array.isArray(value)) {
							for (const entry of value) {
								collectFromObject(entry, into, depth + 1, limit);
								if (limit.count > 500) break;
							}
							return;
						}
						if (typeof value === "object") {
							limit.count += 1;
							const obj = value as Record<string, unknown>;
							for (const key of Object.keys(obj)) {
								const lowered = key.toLowerCase();
								if (
									["route", "path", "href", "url", "to", "link"].some(
										(token) => lowered.includes(token),
									)
								) {
									collectFromObject(obj[key], into, depth + 1, limit);
								} else if (depth < 2) {
									collectFromObject(obj[key], into, depth + 1, limit);
								}
								if (limit.count > 500) break;
							}
						}
					};

					const globalWindow = window as unknown as Record<string, any>;
					const globalRouteSources = [
						globalWindow.__ROUTES__,
						globalWindow.__ROUTE_DATA__,
						globalWindow.__PAGE_LIST__,
						globalWindow.__PAGES__,
						globalWindow.__APP_DATA__,
						globalWindow.__STATE__,
						globalWindow.__NEXT_DATA__?.props?.pageProps,
						globalWindow.__NUXT__?.router?.options?.routes,
						globalWindow.__NUXT__?.data,
						globalWindow.__SAPPER__?.routes,
					];

					globalRouteSources
						.filter((source) => source !== undefined && source !== null)
						.forEach((source) => collectFromObject(source, discovered));

					return Array.from(discovered);
				});
			},
			catch: () => [] as readonly string[],
		}).pipe(
			Effect.flatMap((links) =>
				Effect.forEach(
					links,
					(link) =>
						Effect.sync(() => {
							try {
								if (!link) return Option.none<string>();
								const url = new URL(link);
								if (
									(url.protocol !== "http:" && url.protocol !== "https:") ||
									!hostMatchesFilters(url.hostname) ||
									isAssetUrl(url.pathname)
								) {
									return Option.none<string>();
								}
								url.hash = "";
								return Option.some(url.toString());
							} catch {
								return Option.none<string>();
							}
						}),
					{
						concurrency: Math.max(
							1,
							Math.min(LINK_FILTER_CONCURRENCY, Math.max(1, links.length)),
						),
					},
				).pipe(
					Effect.map((options) => {
						const uniqueLinks = new Set<string>();
						for (const option of options) {
							if (Option.isSome(option)) uniqueLinks.add(option.value);
						}
						return Array.from(uniqueLinks);
					}),
				),
			),
			Effect.orElseSucceed(() => [] as readonly string[]),
		);

	return { prepareForLinkDiscovery, extractLinks };
};
