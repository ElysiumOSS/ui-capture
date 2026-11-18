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
import type { Page } from "playwright";

/** Internal presentation code only; authored JSON never contains executable code. */
export const showPresentation = async (
	page: Page,
	caption: string,
	cursor: boolean,
): Promise<void> => {
	await page.evaluate(
		({ caption, cursor }) => {
			let host = document.getElementById("ui-capture-presentation");
			if (!host) {
				host = document.createElement("div");
				host.id = "ui-capture-presentation";
				host.style.cssText =
					"position:fixed;inset:0;width:100vw;height:100vh;border:0;margin:0;padding:0;background:transparent;pointer-events:none;z-index:2147483647;overflow:hidden";
				host.setAttribute("popover", "manual");
				const shadow = host.attachShadow({ mode: "open" });
				const label = document.createElement("div");
				label.id = "caption";
				label.style.cssText =
					"position:absolute;bottom:6%;left:6%;max-width:80%;max-height:25%;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;box-sizing:border-box;padding:14px 22px;border-radius:12px;color:#fff;background:rgba(12,16,24,.84);font:500 clamp(14px,2vw,28px)/1.4 system-ui,sans-serif;box-shadow:0 3px 20px #0004;white-space:pre-wrap";
				const pointer = document.createElement("div");
				pointer.id = "pointer";
				pointer.style.cssText =
					"position:absolute;width:15px;height:15px;border:2px solid white;background:#2229;border-radius:50%;box-shadow:0 1px 5px #0008;transform:translate(-50%,-50%);left:-100px;top:-100px";
				shadow.append(label, pointer);
				document.documentElement.append(host);
				host.showPopover();
				document.addEventListener(
					"mousemove",
					(event) => {
						pointer.style.left = `${event.clientX}px`;
						pointer.style.top = `${event.clientY}px`;
					},
					true,
				);
				document.addEventListener(
					"pointerdown",
					() => {
						pointer.animate(
							[
								{ scale: "1", boxShadow: "0 0 0 0 #ffffffaa" },
								{ scale: ".8", boxShadow: "0 0 0 14px #ffffff00" },
							],
							{ duration: 420 },
						);
					},
					true,
				);
			}
			const label = host.shadowRoot?.getElementById("caption");
			const pointer = host.shadowRoot?.getElementById("pointer");
			if (label) {
				label.textContent = caption;
				label.style.display = caption ? "-webkit-box" : "none";
			}
			if (pointer) pointer.style.display = cursor ? "block" : "none";
			// Move above a dialog that entered the top layer since the previous step.
			host.hidePopover();
			host.showPopover();
		},
		{ caption, cursor },
	);
};

/** The raw video marker is removed before the tour's timeline and screenshots. */
export const showSyncMarker = async (
	page: Page,
	color: "magenta" | "cyan" | null,
): Promise<void> => {
	await page.evaluate((color) => {
		document.getElementById("ui-capture-sync")?.remove();
		if (color === null) return;
		const marker = document.createElement("div");
		marker.id = "ui-capture-sync";
		marker.style.cssText = `position:fixed;left:0;top:0;width:32px;height:32px;margin:0;padding:0;border:0;background:${color === "magenta" ? "#ff00ff" : "#00ffff"};z-index:2147483647;pointer-events:none`;
		marker.setAttribute("popover", "manual");
		document.documentElement.append(marker);
		marker.showPopover();
	}, color);
};
