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

import { lookup } from "node:dns/promises";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importMusic } from "./music.js";
import { readMusicUrl, safeMusicUrl } from "./music-http.js";

vi.mock("node:dns/promises", () => ({
	lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));
afterEach(() => vi.restoreAllMocks());
const response = (
	body: string,
	statusCode = 200,
	headers: Record<string, string> = { "content-type": "application/json" },
) => {
	return vi
		.spyOn(https, "request")
		.mockImplementation((_url, _options, callback) => {
			const request = new EventEmitter() as ReturnType<typeof https.request>;
			request.end = () => {
				queueMicrotask(() => {
					const stream = Object.assign(new PassThrough(), {
						statusCode,
						headers,
					});
					callback?.(stream as never);
					stream.end(body);
				});
				return request;
			};
			request.destroy = () => {
				request.emit("error", new Error("aborted"));
				return request;
			};
			return request;
		});
};
describe("bounded music HTTP", () => {
	it.each([
		"http://localhost/x",
		"http://127.0.0.1/x",
		"http://10.0.0.1/x",
		"http://169.254.169.254/x",
		"http://[::1]/x",
		"http://[::ffff:127.0.0.1]/x",
		"ftp://example.com/x",
		"https://user:pass@example.com/x",
	])("rejects unsafe URL %s", (url) =>
		expect(() => safeMusicUrl(url)).toThrow());
	it("reads a bounded JSON response through a pinned DNS lookup", async () => {
		const spy = response('{"results":[]}');
		expect(
			(await readMusicUrl("https://example.com", { kind: "json" })).toString(),
		).toBe('{"results":[]}');
		expect(spy.mock.calls[0][1]).toHaveProperty("lookup");
		expect(spy.mock.calls[0][1]).toHaveProperty("family", 4);
	});
	it("rejects private DNS resolutions before connecting", async () => {
		vi.mocked(lookup).mockResolvedValueOnce([
			{ address: "10.0.0.1", family: 4 },
		] as never);
		const spy = response("{}");
		await expect(
			readMusicUrl("https://example.com", { kind: "json" }),
		).rejects.toThrow(/private|public/);
		expect(spy).not.toHaveBeenCalled();
	});
	it("rejects redirects to local resources", async () => {
		response("", 302, { location: "http://127.0.0.1/secret" });
		await expect(
			readMusicUrl("https://example.com", { kind: "json" }),
		).rejects.toThrow(/private|public/);
	});
	it("bounds redirect count", async () => {
		const spy = response("", 302, { location: "https://example.com/again" });
		await expect(
			readMusicUrl("https://example.com", { kind: "json" }),
		).rejects.toThrow(/redirect/i);
		expect(spy.mock.calls.length).toBeLessThanOrEqual(6);
	});
	it("rejects oversized responses even without content-length", async () => {
		response("123456");
		await expect(
			readMusicUrl("https://example.com", { kind: "json", maxBytes: 5 }),
		).rejects.toThrow(/limit|large/);
	});
	it("rejects HTML as audio and exposes rate limits", async () => {
		response("<html>", 200, { "content-type": "text/html" });
		await expect(
			readMusicUrl("https://example.com", { kind: "audio" }),
		).rejects.toThrow(/content|audio/);
		vi.restoreAllMocks();
		response("", 429);
		await expect(
			readMusicUrl("https://example.com", { kind: "json" }),
		).rejects.toThrow(/429|rate/);
	});
	it("does not connect after cancellation", async () => {
		const spy = response("{}");
		await expect(
			readMusicUrl("https://example.com", {
				kind: "json",
				signal: AbortSignal.abort(),
			}),
		).rejects.toThrow();
		expect(spy).not.toHaveBeenCalled();
	});
	it("times out a stalled response", async () => {
		vi.spyOn(https, "request").mockImplementation(
			(_url, _options, callback) => {
				const request = new EventEmitter() as ReturnType<typeof https.request>;
				let stream: PassThrough;
				request.end = () => {
					stream = Object.assign(new PassThrough(), {
						statusCode: 200,
						headers: { "content-type": "application/json" },
					});
					callback?.(stream as never);
					return request;
				};
				request.destroy = () => {
					stream?.destroy(new Error("aborted"));
					request.emit("error", new Error("aborted"));
					return request;
				};
				return request;
			},
		);
		await expect(
			readMusicUrl("https://example.com", { kind: "json", timeoutMs: 30 }),
		).rejects.toThrow(/time|abort/i);
	});
});

describe("music download lifetime", () => {
	it("waits for a pending destination open before closing and cleaning a cancelled import", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "music-http-"));
		const outputDir = path.join(directory, "asset");
		const originalOpen = fs.open.bind(fs);
		let release: () => void = () => {};
		let opened: () => void = () => {};
		const opening = new Promise<void>((resolve) => {
			opened = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			opened();
			await gate;
			handle = await originalOpen(...args);
			return handle;
		});
		response("audio bytes", 200, { "content-type": "audio/mpeg" });
		const controller = new AbortController();
		const pending = importMusic("https://example.com/song.mp3", {
			outputDir,
			title: "Track",
			creator: "Creator",
			sourceUrl: "https://example.com",
			license: "test",
			licenseUrl: "https://example.com/license",
			signal: controller.signal,
		});
		const rejected = expect(pending).rejects.toThrow(/abort/i);
		await opening;
		controller.abort();
		release();
		await rejected;
		expect(handle?.fd).toBe(-1);
		expect(await fs.stat(outputDir).catch(() => undefined)).toBeUndefined();
		await fs.rm(directory, { recursive: true, force: true });
	});
	it("closes a stalled response when opening the download destination fails", async () => {
		let stream: PassThrough | undefined;
		const destroy = vi.fn();
		vi.spyOn(fs, "open").mockRejectedValueOnce(new Error("EACCES fixture"));
		vi.spyOn(https, "request").mockImplementation(
			(_url, _options, callback) => {
				const request = new EventEmitter() as ReturnType<typeof https.request>;
				request.end = () => {
					stream = Object.assign(new PassThrough(), {
						statusCode: 200,
						headers: { "content-type": "audio/mpeg" },
					});
					callback?.(stream as never);
					return request;
				};
				request.destroy = () => {
					destroy();
					return request;
				};
				return request;
			},
		);
		await expect(
			readMusicUrl("https://example.com/audio", {
				kind: "audio",
				destination: "fixture",
			}),
		).rejects.toThrow(/EACCES/);
		expect(stream?.destroyed).toBe(true);
		expect(destroy).toHaveBeenCalled();
	});
	it("includes a stalled DNS lookup in the request deadline", async () => {
		vi.mocked(lookup).mockImplementationOnce(() => new Promise(() => {}));
		await expect(
			readMusicUrl("https://example.com", { kind: "json", timeoutMs: 20 }),
		).rejects.toThrow(/timed out/);
	});
});
