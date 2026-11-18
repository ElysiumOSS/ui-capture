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
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

const privateAddresses = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 3],
] as const)
	privateAddresses.addSubnet(address, prefix);
const publicV6 = new BlockList();
publicV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
	["2001::", 32],
	["2001:db8::", 32],
	["2002::", 16],
] as const)
	privateAddresses.addSubnet(address, prefix, "ipv6");
const requirePublicAddress = (address: string): void => {
	const family = isIP(address);
	if (
		!family ||
		(family === 4
			? privateAddresses.check(address)
			: !publicV6.check(address, "ipv6") ||
				privateAddresses.check(address, "ipv6"))
	)
		throw new Error(
			"Music URLs must resolve to public addresses, not private or reserved networks",
		);
};
/** Reject URL credentials, non-web protocols and obvious local/private destinations. */
export const safeMusicUrl = (value: string): URL => {
	const url = new URL(value);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password
	)
		throw new Error("Music URLs require HTTP(S) without credentials");
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		(!host.includes(".") && !isIP(host))
	)
		throw new Error("Music URLs require a public hostname");
	if (isIP(host)) requirePublicAddress(host);
	return url;
};
interface MusicRequestOptions {
	readonly kind: "json" | "audio";
	readonly maxBytes?: number;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
	readonly destination?: string;
}

/** One total deadline includes DNS, redirects and body reads; media streams to disk. */
export const readMusicUrl = async (
	value: string,
	options: MusicRequestOptions,
): Promise<Buffer> => {
	const timeoutMs =
		options.timeoutMs ?? (options.kind === "json" ? 15000 : 120000);
	const maxBytes =
		options.maxBytes ??
		(options.kind === "json" ? 2 * 1024 * 1024 : 100 * 1024 * 1024);
	if (
		!Number.isFinite(timeoutMs) ||
		timeoutMs <= 0 ||
		timeoutMs > 120000 ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes <= 0 ||
		maxBytes > 100 * 1024 * 1024
	)
		throw new Error("Invalid music request limits");
	const controller = new AbortController();
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;
	const timer = setTimeout(
		() => controller.abort(new Error("Music request timed out")),
		timeoutMs,
	);
	let file: Awaited<ReturnType<typeof fs.open>> | undefined;
	try {
		signal.throwIfAborted();
		let url = safeMusicUrl(value);
		for (let redirects = 0; redirects <= 5; redirects++) {
			signal.throwIfAborted();
			// Pin the validated DNS result to the socket lookup to prevent DNS rebinding.
			const host = url.hostname.replace(/^\[|\]$/g, "");
			const addresses = (await new Promise<
				| Awaited<ReturnType<typeof lookup>>
				| { address: string; family: number }[]
			>((resolve, reject) => {
				const abort = () => reject(signal.reason);
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort();
				lookup(host, { all: true })
					.then(resolve, reject)
					.finally(() => signal.removeEventListener("abort", abort));
			})) as { address: string; family: number }[];
			if (!addresses.length)
				throw new Error("Music host has no public address");
			for (const item of addresses) requirePublicAddress(item.address);
			const address = addresses[0];
			const result = await new Promise<{ location?: string; bytes?: Buffer }>(
				(resolve, reject) => {
					let receiving = false;
					let incoming: http.IncomingMessage | undefined;
					const request = (url.protocol === "https:" ? https : http).request(
						url,
						{
							headers: {
								"User-Agent": "ui-capture music (Openverse client)",
								Accept:
									options.kind === "json"
										? "application/json"
										: "audio/*,application/octet-stream",
							},
							lookup: (_hostname, _lookupOptions, callback) =>
								callback(null, address.address, address.family),
							agent: false,
							family: address.family,
						},
						(response) => {
							receiving = true;
							incoming = response;
							void (async () => {
								const status = response.statusCode ?? 0;
								if ([301, 302, 303, 307, 308].includes(status)) {
									response.destroy();
									if (!response.headers.location)
										throw new Error("Music redirect is missing its location");
									return { location: response.headers.location };
								}
								if (status !== 200) {
									response.destroy();
									throw new Error(
										status === 429
											? "Music provider rate limited this request (HTTP 429); try again later"
											: `Music provider returned HTTP ${status}`,
									);
								}
								const type = (response.headers["content-type"] ?? "")
									.split(";")[0]
									.toLowerCase();
								const allowed =
									options.kind === "json"
										? type === "application/json"
										: type.startsWith("audio/") ||
											[
												"application/ogg",
												"application/octet-stream",
												"video/mp4",
											].includes(type);
								if (!allowed) {
									response.destroy();
									throw new Error(
										`Unexpected music ${options.kind} content type: ${type || "missing"}`,
									);
								}
								if (Number(response.headers["content-length"]) > maxBytes) {
									response.destroy();
									throw new Error("Music response exceeds byte limit");
								}
								if (options.destination)
									file = await fs.open(options.destination, "wx");
								signal.throwIfAborted();
								const chunks: Buffer[] = [];
								let size = 0;
								for await (const chunk of response) {
									signal.throwIfAborted();
									const bytes = Buffer.from(chunk);
									size += bytes.length;
									if (size > maxBytes)
										throw new Error("Music response exceeds byte limit");
									if (file) await file.writeFile(bytes);
									else chunks.push(bytes);
								}
								signal.throwIfAborted();
								if (!size) throw new Error("Music response is empty");
								return { bytes: Buffer.concat(chunks) };
							})().then(resolve, (error) => {
								response.destroy();
								request.destroy();
								reject(signal.aborted ? signal.reason : error);
							});
						},
					);
					const abort = () => {
						incoming?.destroy();
						request.destroy();
						if (!receiving) reject(signal.reason);
					};
					signal.addEventListener("abort", abort, { once: true });
					request.on("error", (error) => {
						if (!receiving) reject(error);
					});
					request.on("close", () => signal.removeEventListener("abort", abort));
					if (signal.aborted) abort();
					else request.end();
				},
			);
			if (!result.location) return result.bytes ?? Buffer.alloc(0);
			url = safeMusicUrl(new URL(result.location, url).href);
		}
		throw new Error("Too many music redirects");
	} finally {
		clearTimeout(timer);
		await file?.close();
	}
};
