import logger from "../lib/logger";
import options from "../lib/options";
import bridge, { type BridgeInfo } from "../lib/bridge";
import { baseConfigStorage, fetchBaseConfig } from "../lib/chromecastConfigApi";

import defaultOptions from "../defaultOptions";
import messaging from "../messaging";

import castManager from "./castManager";
import deviceManager from "./deviceManager";

import { initAction } from "./action";
import { initMenus } from "./menus";
import { initWhitelist } from "./whitelist";
import { cacheUaInfo, getChromeUserAgentString } from "../lib/userAgents";

const _ = browser.i18n.getMessage;

browser.runtime.onInstalled.addListener(async details => {
    switch (details.reason) {
        case "install": {
            await options.setAll(defaultOptions);
            init();
            break;
        }
        case "update": {
            await options.update(defaultOptions);
            break;
        }
    }
});

async function notifyBridgeCompat() {
    logger.info("checking for bridge...");
    let info: BridgeInfo;
    try {
        info = await bridge.getInfo();
    } catch (err) {
        logger.info("... bridge issue!");
        return;
    }

    if (info.isVersionCompatible) {
        logger.info("... bridge compatible!");
    } else {
        logger.info("... bridge incompatible!");
        const updateNotificationId = await browser.notifications.create({
            type: "basic",
            title: `${_("extensionName")} — ${_(
                "optionsBridgeIssueStatusTitle"
            )}`,
            message: info.isVersionOlder
                ? _("optionsBridgeOlderAction")
                : _("optionsBridgeNewerAction")
        });

        browser.notifications.onClicked.addListener(notificationId => {
            if (notificationId !== updateNotificationId) return;
            browser.tabs.create({
                url: `https://github.com/hensm/fx_cast/releases/tag/v${info.expectedVersion}`
            });
        });
    }
}

async function cacheBaseConfig() {
    const { baseConfigUpdated } = await baseConfigStorage.get("baseConfigUpdated");
    if (!baseConfigUpdated || (Date.now() - baseConfigUpdated) / 1000 >= 172800) {
        logger.info("Fetching updated Chromecast base config...");
        const baseConfig = await fetchBaseConfig();
        if (baseConfig) {
            await baseConfigStorage.set({ baseConfig, baseConfigUpdated: Date.now() });
        }
    }
}

let isInitialized = false;

async function init() {
    if (isInitialized) return;
    if (!(await options.getAll())) return;

    logger.info("init");
    isInitialized = true;

    await notifyBridgeCompat();
    await deviceManager.init();
    await castManager.init();
    await initAction();
    await initMenus();
    await initWhitelist();

    messaging.onMessage.addListener(message => {
        if (message.subject === "main:refreshDeviceManager") deviceManager.refresh();
    });

    // --- FEATURE 11: VPN / PROXY SMART-BYPASS ---
    // Forces WebRTC and local cast traffic to completely bypass active VPNs
    if (browser.proxy && browser.proxy.onRequest) {
        browser.proxy.onRequest.addListener(
            (details) => {
                try {
                    const url = new URL(details.url);
                    // Match local IPs: 192.168.x.x, 10.x.x.x, 172.16.x.x, localhost
                    const isLocal = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|127\.|localhost)/.test(url.hostname);
                    if (isLocal) {
                        return [{ type: "direct" }]; // Bypass VPN
                    }
                } catch (err) {}
                return []; // Use default proxy/VPN behavior for everything else
            },
            { urls: ["<all_urls>"] }
        );
        logger.info("VPN Smart-Bypass initialized for local Cast traffic.");
    }

    // --- FEATURE 12: BOSS KEY ---
    browser.commands.onCommand.addListener((command) => {
        if (command === "boss-key") {
            logger.info("🚨 BOSS KEY ACTIVATED! Killing all casts and muting tabs...");
            // 1. Kill the Casts
            castManager.stopAll();
            // 2. Mute the browser
            browser.tabs.query({ currentWindow: true }).then(tabs => {
                tabs.forEach(t => {
                    if (t.id) browser.tabs.update(t.id, { muted: true }).catch(()=>{});
                });
            });
        }
    });
}

cacheUaInfo();
cacheBaseConfig();
init();
