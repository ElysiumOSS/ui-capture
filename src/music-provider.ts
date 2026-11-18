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
// cspell:words publicdomain creativecommons noreferrer

import { safeMusicUrl } from "./music-http.js";

export interface MusicTrack {
	readonly id: string;
	readonly provider: "openverse" | "manual";
	readonly title: string;
	readonly creator: string;
	readonly sourceUrl: string;
	readonly license: string;
	readonly licenseVersion: string;
	readonly licenseUrl: string;
	readonly attribution: string;
	readonly audioUrl?: string;
}
export const musicText = (value: unknown, label: string): string => {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > 10000 ||
		Array.from(value).some(
			(character) =>
				character.charCodeAt(0) < 32 &&
				![9, 10, 13].includes(character.charCodeAt(0)),
		)
	)
		throw new Error(`Invalid music ${label}`);
	return value.trim();
};
export const musicId = (value: unknown): string => {
	const id = musicText(value, "ID");
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
	)
		throw new Error("Music ID must be an Openverse UUID");
	return id;
};
export const musicSearchUrl = (query: string, limit = 10): URL => {
	musicText(query, "query");
	if (query.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 20)
		throw new Error(
			"Music search requires a query up to 500 characters and a limit from 1 to 20",
		);
	const url = new URL("https://api.openverse.org/v1/audio/");
	url.search = new URLSearchParams({
		q: query,
		category: "music",
		license: "cc0,pdm,by",
		page_size: String(limit),
	}).toString();
	return url;
};
/** Accept only the explicitly supported licenses and their canonical CC URLs. */
export const validateOpenverseLicense = (
	license: string,
	version: string,
	url: string,
): void => {
	const prefixes: Record<string, string> = {
		by: "licenses/by",
		cc0: "publicdomain/zero",
		pdm: "publicdomain/mark",
	};
	const prefix = prefixes[license];
	if (!prefix || !/^\d\.\d$/.test(version))
		throw new Error("Unsupported Openverse music license");
	const parsed = safeMusicUrl(url);
	if (
		parsed.hostname !== "creativecommons.org" ||
		parsed.pathname !== `/${prefix}/${version}/` ||
		parsed.search ||
		parsed.hash
	)
		throw new Error("Openverse license URL does not match its license");
};
export const parseOpenverseTrack = (value: unknown): MusicTrack => {
	if (!value || typeof value !== "object")
		throw new Error("Invalid Openverse track metadata");
	const raw = value as Record<string, unknown>;
	if (raw.category !== "music") throw new Error("Openverse track is not music");
	const license = musicText(raw.license, "license");
	const licenseVersion = musicText(raw.license_version, "license version");
	const licenseUrl = musicText(raw.license_url, "license URL");
	validateOpenverseLicense(license, licenseVersion, licenseUrl);
	return {
		id: musicId(raw.id),
		provider: "openverse",
		title: musicText(raw.title, "title"),
		creator: musicText(raw.creator, "creator"),
		sourceUrl: safeMusicUrl(musicText(raw.foreign_landing_url, "source URL"))
			.href,
		audioUrl: safeMusicUrl(musicText(raw.url, "audio URL")).href,
		license,
		licenseVersion,
		licenseUrl,
		attribution:
			typeof raw.attribution === "string" && raw.attribution.trim()
				? musicText(raw.attribution, "attribution")
				: `${musicText(raw.title, "title")} by ${musicText(raw.creator, "creator")}; ${license} ${licenseVersion}; ${licenseUrl}`,
	};
};
export const musicCredits = (track: MusicTrack): string =>
	`${track.title}\nCreator: ${track.creator}\nSource: ${track.sourceUrl}\nLicense: ${track.license} ${track.licenseVersion}\nLicense URL: ${track.licenseUrl}\n${track.attribution}\nVerify the original source and publish the required credits with your video.\n`;
const escapeHtml = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
const licenseLabel = (track: MusicTrack): string => {
	if (track.license === "by") return `CC BY ${track.licenseVersion}`;
	if (track.license === "cc0") return `CC0 ${track.licenseVersion}`;
	if (track.license === "pdm") return "Public Domain Mark";
	if (track.license === "mixkit-free") return "Mixkit Free";
	return `${track.license} ${track.licenseVersion}`.trim();
};
export const renderMusicPreview = (
	tracks: readonly MusicTrack[],
	localAudio?: string,
): string => {
	const imported =
		tracks.length > 0 && tracks.every((track) => track.provider === "manual");
	const title = imported ? "Imported music preview" : "Music preview";
	const notice = imported
		? "Imported audio: verify the supplied source and license before publishing."
		: "Made using Openverse; not endorsed or certified by Openverse. Verify each original source and license before publishing.";
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; media-src https: http: file:; base-uri 'none'; form-action 'none'"><title>${title}</title><style>body{font:16px system-ui;max-width:850px;margin:3rem auto;padding:0 1rem;background:#10151d;color:#eef2f8}article{border-top:1px solid #687386;padding:1rem 0}h2{margin:.3rem 0}a{color:#93c5fd}audio{display:block;width:100%;margin:1rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.85rem}code{overflow-wrap:anywhere}summary{cursor:pointer}</style></head><body><h1>${title}</h1><p>${notice}</p><p>Publish required credits with your video. Local previews are for personal workflow use.</p>${tracks.map((track) => `<article><h2>${escapeHtml(track.title)}</h2><p>By ${escapeHtml(track.creator)} · ${escapeHtml(licenseLabel(track))}</p><a href="${escapeHtml(track.sourceUrl)}" rel="noreferrer">Original source</a> · <a href="${escapeHtml(track.licenseUrl)}" rel="noreferrer">License</a><audio controls preload="none" src="${escapeHtml(localAudio ?? track.audioUrl ?? "")}"></audio><details><summary>Credits and download</summary><pre>${escapeHtml(musicCredits(track))}</pre>${track.provider === "openverse" && !localAudio ? `<code>ui-capture music fetch ${escapeHtml(track.id)} --output-dir ./music/${escapeHtml(track.id)}</code>` : ""}</details></article>`).join("")}</body></html>`;
};
