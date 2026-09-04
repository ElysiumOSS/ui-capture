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
import {
	canonicalizeHost,
	computeHostSuffixes,
	createHostFilterState,
	getCaptureDir,
	getRouteName,
	isAllowedOrigin,
	normalizeUrl,
	stateResultKey,
} from "./shared.js";

describe("canonicalizeHost", () => {
	it("strips protocol, www, paths, and lowercases", () => {
		expect(canonicalizeHost("https://www.Example.COM/some/path")).toBe(
			"example.com",
		);
		expect(canonicalizeHost("HTTPS://APP.example.com")).toBe("app.example.com");
		expect(canonicalizeHost("  example.com  ")).toBe("example.com");
		expect(canonicalizeHost("www.example.com/")).toBe("example.com");
	});
});

describe("computeHostSuffixes", () => {
	it("returns the host plus every parent suffix", () => {
		expect(computeHostSuffixes("a.b.example.com")).toEqual([
			"a.b.example.com",
			"b.example.com",
			"example.com",
			"com",
		]);
	});

	it("handles single-segment hosts", () => {
		expect(computeHostSuffixes("localhost")).toEqual(["localhost"]);
	});
});

describe("createHostFilterState", () => {
	it("only allows the primary host when includeSubdomains=false", () => {
		const f = createHostFilterState();
		f.hydrate("example.com", []);
		expect(f.hostMatchesFilters("example.com", false)).toBe(true);
		expect(f.hostMatchesFilters("www.example.com", false)).toBe(true);
		expect(f.hostMatchesFilters("api.example.com", false)).toBe(false);
		expect(f.hostMatchesFilters("evil.com", false)).toBe(false);
	});

	it("allows subdomains when includeSubdomains=true", () => {
		const f = createHostFilterState();
		f.hydrate("example.com", []);
		expect(f.hostMatchesFilters("api.example.com", true)).toBe(true);
		expect(f.hostMatchesFilters("a.b.example.com", true)).toBe(true);
		// Different TLD is rejected (no shared suffix with example.com).
		expect(f.hostMatchesFilters("evil.io", true)).toBe(false);
	});

	it("does not leak across the TLD when includeSubdomains=true", () => {
		// Regression: previously "evil.com" matched because the suffix list
		// for "example.com" included the bare TLD "com". Bare-TLD suffixes
		// are dropped during hydrate, so unrelated same-TLD hosts are rejected.
		const f = createHostFilterState();
		f.hydrate("example.com", []);
		expect(f.hostMatchesFilters("evil.com", true)).toBe(false);
		expect(f.hostMatchesFilters("example.org", true)).toBe(false);
	});

	it("honours extra allowed hosts", () => {
		const f = createHostFilterState();
		f.hydrate("example.com", ["cdn.partner.io"]);
		expect(f.hostMatchesFilters("cdn.partner.io", false)).toBe(true);
		expect(f.hostMatchesFilters("partner.io", false)).toBe(false);
		expect(f.hostMatchesFilters("partner.io", true)).toBe(true);
	});

	it("re-hydrating replaces the previous allow-list", () => {
		const f = createHostFilterState();
		f.hydrate("example.com", []);
		expect(f.hostMatchesFilters("example.com", false)).toBe(true);
		f.hydrate("other.org", []);
		expect(f.hostMatchesFilters("example.com", false)).toBe(false);
		expect(f.hostMatchesFilters("other.org", false)).toBe(true);
	});
});

describe("isAllowedOrigin", () => {
	/** The gate as the service wires it: a real host filter, a real seed. */
	const gate = (
		candidate: string,
		seed: string,
		options?: {
			readonly primaryHost?: string;
			readonly allowedHosts?: readonly string[];
			readonly includeSubdomains?: boolean;
		},
	) => {
		const seedUrl = new URL(seed);
		const filters = createHostFilterState();
		filters.hydrate(
			options?.primaryHost ?? seedUrl.hostname,
			options?.allowedHosts ?? [],
		);
		return isAllowedOrigin(new URL(candidate), seedUrl, (hostname) =>
			filters.hostMatchesFilters(hostname, options?.includeSubdomains ?? false),
		);
	};

	it("allows the seed origin itself", () => {
		expect(gate("https://app.test/dash", "https://app.test/")).toBe(true);
	});

	it("rejects a different scheme on the same host and port", () => {
		// A downgrade is a different server, and for a `request` step it is a
		// POST sent in the clear at one.
		expect(gate("http://app.test/", "https://app.test/")).toBe(false);
		expect(gate("https://app.test/", "http://app.test/")).toBe(false);
	});

	it("rejects a different port on the same host and scheme", () => {
		expect(gate("http://app.test:4000/", "http://app.test:3000/")).toBe(false);
		expect(
			gate("http://127.0.0.1:42269/secret", "http://127.0.0.1:45179/"),
		).toBe(false);
	});

	it("treats a scheme's default port as equal to writing it out", () => {
		// `URL.port` normalizes to "" for 443/80, so neither direction needs
		// special casing.
		expect(gate("https://app.test:443/", "https://app.test/")).toBe(true);
		expect(gate("https://app.test/", "https://app.test:443/")).toBe(true);
		expect(gate("http://app.test:80/", "http://app.test/")).toBe(true);
	});

	it("rejects a host the filter does not allow, however matching the rest", () => {
		expect(gate("https://evil.test/", "https://app.test/")).toBe(false);
	});

	it("defers the host decision to the filter, www and all", () => {
		// `canonicalizeHost` strips `www.`, so the filter answers for both.
		expect(gate("https://www.app.test/", "https://app.test/")).toBe(true);
	});

	it("honours --allowed-hosts, still at the seed's scheme and port", () => {
		const allowedHosts = ["cdn.partner.io"];
		expect(
			gate("https://cdn.partner.io/x", "https://app.test/", { allowedHosts }),
		).toBe(true);
		// The extra host is allowed; a different port on it is still not.
		expect(
			gate("https://cdn.partner.io:8443/x", "https://app.test/", {
				allowedHosts,
			}),
		).toBe(false);
		expect(
			gate("http://cdn.partner.io/x", "https://app.test/", { allowedHosts }),
		).toBe(false);
	});

	it("follows --include-subdomains for the host half only", () => {
		expect(gate("https://api.app.test/", "https://app.test/")).toBe(false);
		expect(
			gate("https://api.app.test/", "https://app.test/", {
				includeSubdomains: true,
			}),
		).toBe(true);
		// Subdomains widen the host, never the scheme or the port.
		expect(
			gate("https://api.app.test:8443/", "https://app.test/", {
				includeSubdomains: true,
			}),
		).toBe(false);
		expect(
			gate("http://api.app.test/", "https://app.test/", {
				includeSubdomains: true,
			}),
		).toBe(false);
	});

	it("rejects a non-http scheme that shares the seed's host", () => {
		// `new URL("file:///etc/passwd").hostname` is "", but a data: or ws: URL
		// can carry the seed's host and would otherwise differ only by scheme.
		expect(gate("ws://app.test/", "http://app.test/")).toBe(false);
	});
});

describe("normalizeUrl", () => {
	it("returns origin+pathname with the trailing slash stripped", () => {
		// Even the bare-origin slash is stripped — the result is the origin alone.
		expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
		expect(normalizeUrl("https://example.com/foo/")).toBe(
			"https://example.com/foo",
		);
		expect(normalizeUrl("https://example.com/foo")).toBe(
			"https://example.com/foo",
		);
	});

	it("strips query strings and fragments", () => {
		expect(normalizeUrl("https://example.com/foo?bar=1#x")).toBe(
			"https://example.com/foo",
		);
	});

	it("returns the input unchanged for invalid URLs", () => {
		expect(normalizeUrl("not a url")).toBe("not a url");
	});
});

describe("getRouteName", () => {
	it("returns 'root' for the bare origin", () => {
		expect(getRouteName("https://example.com/")).toBe("root");
		expect(getRouteName("https://example.com")).toBe("root");
	});

	it("slugifies multi-segment paths", () => {
		expect(getRouteName("https://example.com/blog/post-1")).toBe("blog-post-1");
		expect(getRouteName("https://example.com/en/legal/privacy/")).toBe(
			"en-legal-privacy",
		);
	});

	it("returns 'invalid-url' for unparseable input", () => {
		expect(getRouteName("::not-a-url::")).toBe("invalid-url");
	});

	it("collapses consecutive non-alphanumeric runs into single dashes", () => {
		expect(getRouteName("https://example.com/A%20B")).toBe("a-20b");
	});
});

describe("getCaptureDir", () => {
	it("is the route directory when no state is named", () => {
		// Unchanged from before scripted states existed: a crawled route still
		// writes straight into <outputDir>/<route>/.
		expect(getCaptureDir("out", "https://example.com/blog/post-1")).toBe(
			path.join("out", "blog-post-1"),
		);
		expect(getCaptureDir("out", "https://example.com/")).toBe(
			path.join("out", "root"),
		);
	});

	it("nests a scripted state under the route it belongs to", () => {
		expect(getCaptureDir("out", "https://example.com/", "spawn-dialog")).toBe(
			path.join("out", "root", "states", "spawn-dialog"),
		);
	});

	it("cannot collide with the route's own screenshot or video trees", () => {
		// `states` is a fixed segment and a state name is pattern-constrained to
		// [a-z0-9-]+, so no state can land on "screenshots" or "videos".
		const routeDir = getCaptureDir("out", "https://example.com/");
		const stateDir = getCaptureDir(
			"out",
			"https://example.com/",
			"screenshots",
		);
		expect(stateDir).toBe(path.join(routeDir, "states", "screenshots"));
		expect(stateDir).not.toBe(path.join(routeDir, "screenshots"));
	});

	it("keeps two states on the same route in separate directories", () => {
		expect(getCaptureDir("out", "https://example.com/", "a")).not.toBe(
			getCaptureDir("out", "https://example.com/", "b"),
		);
	});
});

describe("stateResultKey", () => {
	it("never collides with the route key for the same URL", () => {
		const url = "https://example.com/console";
		expect(stateResultKey(url, "safety")).not.toBe(normalizeUrl(url));
	});

	it("separates two states on one URL, and one state across two URLs", () => {
		expect(stateResultKey("https://example.com/", "a")).not.toBe(
			stateResultKey("https://example.com/", "b"),
		);
		expect(stateResultKey("https://example.com/x", "a")).not.toBe(
			stateResultKey("https://example.com/y", "a"),
		);
	});

	it("ignores query and fragment, matching normalizeUrl", () => {
		expect(stateResultKey("https://example.com/c?x=1#y", "a")).toBe(
			stateResultKey("https://example.com/c", "a"),
		);
	});
});
