import bridge from "../lib/bridge";
import {
    type BaseConfig,
    baseConfigStorage,
    getAppTag
} from "../lib/chromecastConfigApi";
import logger from "../lib/logger";
import messaging, { type Message, type Port } from "../messaging";
import options from "../lib/options";
import type { TypedMessagePort } from "../lib/TypedMessagePort";

import {
    type ReceiverDevice,
    type ReceiverSelectorAppInfo,
    ReceiverSelectorMediaType,
    type ReceiverSelectorPageInfo
} from "../types";

import type { ApiConfig } from "../cast/sdk/classes";
import { AutoJoinPolicy, ReceiverAction } from "../cast/sdk/enums";
import { createReceiver } from "../cast/utils";

import ReceiverSelector, {
    type ReceiverSelection,
    type ReceiverSelectorMediaMessage,
    type ReceiverSelectorReceiverMessage
} from "./receiverSelector";

import deviceManager from "./deviceManager";
import { ActionState, updateActionState } from "./action";

type AnyPort = Port | TypedMessagePort<Message>;

export interface ContentContext {
    tabId: number;
    frameId: number;
    origin?: string;
}

function isSameContext(ctx1?: ContentContext, ctx2?: ContentContext) {
    if (!ctx1 || !ctx2) return false;
    return ctx1?.tabId === ctx2?.tabId && ctx1?.frameId === ctx2?.frameId;
}

interface CastSession {
    bridgePort: Port;
    deviceId: string;
    appId: string;
    sessionId?: string;
    autoJoinContexts: Set<ContentContext>;
}

async function createCastSession(opts: {
    deviceId: string;
    instance: CastInstance;
    appId?: string;
}) {
    if (!opts.appId) {
        if (!opts.instance.apiConfig?.sessionRequest) {
            throw logger.error("App ID not provided and instance missing valid session request!");
        }
        opts.appId = opts.instance.apiConfig.sessionRequest.appId;
    }

    const session: CastSession = {
        bridgePort: await bridge.connect(),
        deviceId: opts.deviceId,
        appId: opts.appId,
        autoJoinContexts: new Set()
    };

    if (opts.instance.contentContext) {
        session.autoJoinContexts.add(opts.instance.contentContext);
    }

    opts.instance.session = session;
    opts.instance.bridgeMessageListener = message => {
        handleBridgeMessage(opts.instance, message);
    };

    session.bridgePort.onMessage.addListener(opts.instance.bridgeMessageListener);
    session.bridgePort.onDisconnect.addListener(() => destroyCastInstance(opts.instance));

    if (opts.instance.contentContext?.tabId) {
        updateActionState(ActionState.Connecting, opts.instance.contentContext?.tabId);
    }

    return session;
}

function joinSession(instance: CastInstance, session: CastSession) {
    if (!session.sessionId) return;
    instance.session = session;
    instance.bridgeMessageListener = message => handleBridgeMessage(instance, message);

    session.bridgePort.onMessage.addListener(instance.bridgeMessageListener);
    session.bridgePort.onDisconnect.addListener(() => destroyCastInstance(instance));

    const device = deviceManager.getDeviceById(session.deviceId);
    if (!device?.status?.applications?.length) throw logger.error("Invalid device state!");

    const application = device?.status?.applications[0];
    instance.contentPort.postMessage({
        subject: "cast:sessionCreated",
        data: {
            appId: application.appId,
            appImages: [],
            displayName: application.displayName,
            namespaces: application.namespaces,
            receiverFriendlyName: device.friendlyName,
            receiverId: device.id,
            senderApps: [],
            sessionId: session.sessionId,
            statusText: application.statusText,
            transportId: session.sessionId,
            volume: device.status.volume,
            receiver: createReceiver(device),
            media: device.mediaStatus
        }
    });

    if (instance.contentContext?.tabId) {
        updateActionState(ActionState.Connected, instance.contentContext?.tabId);
        browser.tabs.update(instance.contentContext.tabId, { muted: true }).catch(() => {});
    }
}

function leaveSession(instance: CastInstance) {
    if (!instance.session?.sessionId) return;
    instance.contentPort.postMessage({
        subject: "cast:sessionDisconnected",
        data: { sessionId: instance.session.sessionId }
    });
    delete instance.session;
    if (instance.contentContext?.tabId) {
        updateActionState(ActionState.Default, instance.contentContext.tabId);
        browser.tabs.update(instance.contentContext.tabId, { muted: false }).catch(() => {});
    }
}

export interface CastInstance {
    contentPort: AnyPort;
    contentContext?: ContentContext;
    isTrusted: boolean;
    apiConfig?: ApiConfig;
    session?: CastSession;
    bridgeMessageListener?: (message: Message) => void;
}

function createCastInstance(opts: {
    contentPort: AnyPort;
    contentContext?: { tabId: number; frameId?: number };
    isTrusted?: boolean;
}) {
    const instance: CastInstance = {
        contentPort: opts.contentPort,
        isTrusted: opts.isTrusted ?? false
    };

    if (opts.contentContext) {
        instance.contentContext = { tabId: opts.contentContext.tabId, frameId: opts.contentContext.frameId ?? 0 };
    } else if (!(opts.contentPort instanceof MessagePort) && opts.contentPort.sender?.tab?.id) {
        let origin: Optional<string>;
        if (opts.contentPort.sender?.tab?.url) {
            try { ({ origin } = new URL(opts.contentPort.sender.tab.url)); } catch {}
        }
        instance.contentContext = { tabId: opts.contentPort.sender.tab.id, frameId: opts.contentPort.sender.frameId ?? 0, origin };
    }
    return instance;
}

function destroyCastInstance(instance: CastInstance) {
    if (instance.contentPort instanceof MessagePort) {
        instance.contentPort.close();
    } else {
        instance.contentPort.disconnect();
    }
    if (instance.session && instance.bridgeMessageListener) {
        instance.session.bridgePort.onMessage.removeListener(instance.bridgeMessageListener);
    }
    if (instance.contentContext?.tabId) {
        updateActionState(ActionState.Default, instance.contentContext?.tabId);
        browser.tabs.update(instance.contentContext.tabId, { muted: false }).catch(() => {});
    }
    activeInstances.delete(instance);
}

function isValidAutoJoinContext(instance: CastInstance, context: ContentContext) {
    if (!instance.apiConfig?.autoJoinPolicy) return false;
    const { autoJoinPolicy } = instance.apiConfig;
    if (autoJoinPolicy === AutoJoinPolicy.ORIGIN_SCOPED || autoJoinPolicy === AutoJoinPolicy.TAB_AND_ORIGIN_SCOPED) {
        if (context.origin !== instance.contentContext?.origin) return false;
        if (autoJoinPolicy === AutoJoinPolicy.TAB_AND_ORIGIN_SCOPED && !isSameContext(context, instance.contentContext)) return false;
        return true;
    }
    return false;
}

interface AutoJoinTarget {
    session: CastSession;
    autoJoinContext: ContentContext;
}
function findAutoJoinTarget(instance: CastInstance) {
    for (const [, session] of activeSessions) {
        if (!session.sessionId || session.appId !== instance.apiConfig?.sessionRequest.appId) continue;
        for (const context of session.autoJoinContexts) {
            if (isValidAutoJoinContext(instance, context)) {
                return { session, autoJoinContext: context } as AutoJoinTarget;
            }
        }
    }
}

const allowedContentMessages: Array<Message["subject"]> = [
    "main:initializeCastSdk",
    "main:requestSession",
    "main:requestSessionById",
    "main:leaveSession",
    "bridge:sendCastReceiverMessage",
    "bridge:sendCastSessionMessage",
    "main:castCustomMedia", // Added for custom media files
    "main:triggerPiP",
    "main:setAudioSink"
];

let baseConfig: BaseConfig;
let receiverSelector: Optional<ReceiverSelector>;
const activeInstances = new Set<CastInstance>();
const activeSessions = new Map<string, CastSession>();

// Track pending custom URLs so we can LOAD them after the session connects
const pendingCustomMedia = new Map<string, string>();

// --- YOUTUBE AD & SPONSOR BLOCKER ENGINE ---
const sponsorSegments = new Map<string, Array<{start: number, end: number}>>();

async function handleYouTubeAdAndSponsor(instance: CastInstance, mediaStatus: any) {
    if (!mediaStatus) return;
    
    // 1. NATIVE AD BLOCKER (Detects pre-roll/mid-roll Chromecast ads)
    const isAd = mediaStatus.playingAd || 
                 mediaStatus.customData?.playingAd || 
                 (mediaStatus.playerState === 'PLAYING' && mediaStatus.media?.metadata?.title?.startsWith('Ad '));
                 
    if (isAd) {
        logger.info("🔥 YouTube Ad detected! Fast-forwarding over it...");
        // Try skipping ad via standard command
        instance.session?.bridgePort.postMessage({
            subject: "bridge:sendCastSessionMessage",
            data: {
                deviceId: instance.session.deviceId,
                namespace: "urn:x-cast:com.google.cast.media",
                message: { type: "SKIP_AD", requestId: Date.now(), mediaSessionId: mediaStatus.mediaSessionId }
            }
        });
        // Brute force: seek to the absolute end of the ad to force it to finish
        instance.session?.bridgePort.postMessage({
            subject: "bridge:sendCastSessionMessage",
            data: {
                deviceId: instance.session.deviceId,
                namespace: "urn:x-cast:com.google.cast.media",
                message: { type: "SEEK", requestId: Date.now()+1, mediaSessionId: mediaStatus.mediaSessionId, currentTime: mediaStatus.media?.duration || 9999, resumeState: "PLAYBACK_START" }
            }
        });
        return; 
    }

    // 2. SPONSORBLOCK (Fetches API and auto-skips in-video sponsors)
    let videoId = mediaStatus.media?.contentId;
    if (!videoId && mediaStatus.media?.customData?.videoId) videoId = mediaStatus.media.customData.videoId;
    if (videoId && videoId.includes("v=")) videoId = new URLSearchParams(videoId.split("?")[1]).get("v") || videoId;
    
    if (!videoId || videoId.length > 20) return; // Not a valid YouTube ID

    if (!sponsorSegments.has(videoId)) {
        sponsorSegments.set(videoId, []); 
        try {
            const res = await fetch(`https://sponsor.ajay.app/api/skipSegments?videoID=${videoId}&categories=["sponsor","intro","outro","interaction","selfpromo"]`);
            if (res.ok) {
                const data = await res.json();
                const segments = data.map((s: any) => ({ start: s.segment[0], end: s.segment[1] }));
                sponsorSegments.set(videoId, segments);
                logger.info(`🔥 SponsorBlock: Loaded ${segments.length} segments for ${videoId}`);
            }
        } catch (e) {}
    }

    const segments = sponsorSegments.get(videoId);
    if (!segments || segments.length === 0) return;

    const currentTime = mediaStatus.currentTime;
    if (!currentTime) return;

    for (const seg of segments) {
        if (currentTime >= seg.start && currentTime < (seg.end - 1)) {
            logger.info(`🔥 SponsorBlock: Skipping segment! ${currentTime} -> ${seg.end}`);
            instance.session?.bridgePort.postMessage({
                subject: "bridge:sendCastSessionMessage",
                data: {
                    deviceId: instance.session.deviceId,
                    namespace: "urn:x-cast:com.google.cast.media",
                    message: {
                        type: "SEEK",
                        mediaSessionId: mediaStatus.mediaSessionId,
                        requestId: Date.now(),
                        currentTime: seg.end + 0.5
                    }
                }
            });
            break; 
        }
    }
}

const castManager = new (class {
    async init() {
        messaging.onConnect.addListener(async port => {
            if (port.name === "cast") this.createInstance(port);
            else if (port.name === "trusted-cast") this.createInstance(port, undefined, true);
        });

        const updateReceiverAvailability = () => {
            const isAvailable = deviceManager.getDevices().length > 0;
            for (const instance of activeInstances) {
                instance.contentPort.postMessage({
                    subject: "cast:receiverAvailabilityUpdated",
                    data: { isAvailable }
                });
            }
        };

        deviceManager.addEventListener("deviceUp", updateReceiverAvailability);
        deviceManager.addEventListener("deviceDown", updateReceiverAvailability);

        deviceManager.addEventListener("applicationClosed", ev => {
            const session = activeSessions.get(ev.detail.sessionId);
            if (!session?.sessionId) return;

            for (const instance of activeInstances) {
                if (instance.session === session) {
                    instance.contentPort.postMessage({
                        subject: "cast:sessionStopped",
                        data: { sessionId: session.sessionId }
                    });
                    delete instance.session;
                    if (instance.contentContext?.tabId) {
                        updateActionState(ActionState.Default, instance.contentContext.tabId);
                        browser.tabs.update(instance.contentContext.tabId, { muted: false }).catch(() => {});
                    }
                }
            }
            activeSessions.delete(session.sessionId);
        });
    }

    getInstanceAt(tabId: number, frameId?: number) {
        for (const instance of activeInstances) {
            if (instance.contentContext?.tabId === tabId) {
                if (frameId && instance.contentContext.frameId !== frameId) continue;
                return instance;
            }
        }
    }

    getInstanceByDeviceId(deviceId: string) {
        for (const instance of activeInstances) {
            if (instance.session?.deviceId === deviceId) return instance;
        }
    }

    async createInstance(port: AnyPort, contentContext?: ContentContext, isTrusted?: boolean) {
        const instance = await (port instanceof MessagePort
            ? this.createInstanceFromBackground(port, contentContext)
            : this.createInstanceFromContent(port, isTrusted));
        activeInstances.add(instance);
        instance.contentPort.postMessage({
            subject: "cast:instanceCreated",
            data: { isAvailable: (await bridge.getInfo()).isVersionCompatible }
        });
        return instance;
    }

    private async createInstanceFromBackground(contentPort: MessagePort, contentContext?: ContentContext): Promise<CastInstance> {
        const instance = await createCastInstance({ contentPort, contentContext, isTrusted: true });
        if (contentContext) {
            for (const instance of activeInstances) {
                if (isSameContext(instance.contentContext, contentContext)) {
                    destroyCastInstance(instance);
                    break;
                }
            }
        }
        contentPort.addEventListener("message", ev => { handleContentMessage(instance, ev.data); });
        contentPort.start();
        return instance;
    }

    private async createInstanceFromContent(contentPort: Port, isTrusted?: boolean): Promise<CastInstance> {
        if (contentPort.sender?.tab?.id === undefined || contentPort.sender?.frameId === undefined) {
            throw logger.error("Cast instance created from content with an invalid port context.");
        }
        const instance = await createCastInstance({ contentPort, isTrusted });
        const onContentPortMessage = (message: Message) => { handleContentMessage(instance, message); };
        contentPort.onMessage.addListener(onContentPortMessage);
        contentPort.onDisconnect.addListener(() => { destroyCastInstance(instance); });
        return instance;
    }

    async triggerCast(tabId: number, frameId = 0) {
        let selection: Nullable<ReceiverSelection>;
        try {
            selection = await getReceiverSelection({ tabId, frameId });
        } catch (err) {
            logger.error("Failed to get receiver selection (triggerCast)", err);
            return;
        }
        if (!selection) return;
        loadSender(selection, { tabId, frameId });
    }

    stopAll() {
        for (const [sessionId, session] of activeSessions) {
            const device = deviceManager.getDeviceById(session.deviceId);
            if (device) {
                session.bridgePort.postMessage({
                    subject: "bridge:sendCastReceiverMessage",
                    data: {
                        deviceId: session.deviceId,
                        message: { type: "STOP", requestId: 0, sessionId: session.sessionId }
                    }
                });
            }
        }
    }
})();

export default castManager;

async function handleBridgeMessage(instance: CastInstance, message: Message) {
    switch (message.subject) {
        case "main:castSessionCreated": {
            if (receiverSelector?.isOpen && isSameContext(receiverSelector.pageInfo, instance.contentContext) && (await options.get("receiverSelectorWaitForConnection"))) {
                receiverSelector.close();
            }
            const { receiverId: deviceId } = message.data;
            if (!instance.session) { logger.error("Instance is missing session!"); break; }
            
            instance.session.sessionId = message.data.sessionId;
            activeSessions.set(message.data.sessionId, instance.session);
            
            const device = deviceManager.getDeviceById(deviceId);
            if (!device) { logger.error("[on main:castSessionCreated]: Could not find device with ID:", deviceId); break; }
            
            instance.contentPort.postMessage({
                subject: "cast:sessionCreated",
                data: { ...message.data, receiver: createReceiver(device) }
            });
            
            if (instance.contentContext?.tabId) {
                updateActionState(ActionState.Connected, instance.contentContext?.tabId);
                browser.tabs.update(instance.contentContext.tabId, { muted: true }).catch(() => {});
            }

            // --- CUSTOM MEDIA INTERCEPTOR (For .mp4, .m3u8, etc) ---
            const customUrl = pendingCustomMedia.get(deviceId);
            if (customUrl && instance.session) {
                pendingCustomMedia.delete(deviceId);
                
                let contentType = "video/mp4"; // Default fallback
                const lowerUrl = customUrl.toLowerCase();
                if (lowerUrl.includes(".m3u8")) contentType = "application/x-mpegurl";
                else if (lowerUrl.includes(".mp3")) contentType = "audio/mp3";
                else if (lowerUrl.includes(".webm")) contentType = "video/webm";
                else if (lowerUrl.includes(".mkv")) contentType = "video/x-matroska";
                
                // Wait 1.5 seconds for the Default Media Receiver to boot up, then load the video
                setTimeout(() => {
                    instance.session?.bridgePort.postMessage({
                        subject: "bridge:sendCastSessionMessage",
                        data: {
                            deviceId: deviceId,
                            namespace: "urn:x-cast:com.google.cast.media",
                            message: {
                                type: "LOAD",
                                requestId: Date.now(),
                                sessionId: message.data.sessionId,
                                media: {
                                    contentId: customUrl,
                                    contentType: contentType,
                                    streamType: contentType === "application/x-mpegurl" ? "LIVE" : "BUFFERED"
                                },
                                autoplay: true
                            }
                        }
                    });
                }, 1500);
            }
            break;
        }
        case "main:castSessionUpdated":
            // Fire Ad & Sponsor Blocker on every status update!
            if (message.data) handleYouTubeAdAndSponsor(instance, message.data);
            
            instance.contentPort.postMessage({
                subject: "cast:sessionUpdated",
                data: message.data
            });
            break;
    }
    instance.contentPort.postMessage(message);
}

async function handleContentMessage(instance: CastInstance, message: Message) {
    if (!allowedContentMessages.includes(message.subject) && !instance.isTrusted && message.subject !== "main:triggerPiP" && message.subject !== "main:setAudioSink") {
        logger.error(`Forbidden message type! (${message.subject})`);
        destroyCastInstance(instance);
        return;
    }
    const [destination] = message.subject.split(":");
    if (destination === "bridge") instance.session?.bridgePort.postMessage(message);

    switch (message.subject) {
        case "main:castCustomMedia": {
            // Initiate a session with the generic Default Media Receiver app
            const { receiverDevice, mediaUrl } = message.data;
            pendingCustomMedia.set(receiverDevice.id, mediaUrl);
            
            const appId = "CC1AD845"; // Google's official Default Media Receiver
            const session = await createCastSession({ instance, deviceId: receiverDevice.id, appId });
            session.bridgePort.postMessage({
                subject: "bridge:createCastSession",
                data: { appId, receiverDevice }
            });
            break;
        }
        case "main:triggerPiP":
        case "main:setAudioSink": {
            const tabs = await browser.tabs.query({ active: true, windowType: "normal" });
            const activeTabId = tabs[0]?.id;
            if (activeTabId) {
                const targetInstance = castManager.getInstanceAt(activeTabId);
                if (targetInstance) {
                    targetInstance.contentPort.postMessage({
                        subject: message.subject.replace("main:", "cast:"),
                        data: message.data
                    });
                }
            }
            break;
        }
        case "main:initializeCastSdk": {
            instance.apiConfig = message.data.apiConfig;
            instance.contentPort.postMessage({ subject: "cast:receiverAvailabilityUpdated", data: { isAvailable: deviceManager.getDevices().length > 0 } });
            if (instance.apiConfig.autoJoinPolicy === AutoJoinPolicy.PAGE_SCOPED) break;
            const target = findAutoJoinTarget(instance);
            if (target) joinSession(instance, target.session);
            break;
        }
        case "main:requestSession": {
            const { sessionRequest, receiverDevice } = message.data;
            if (receiverDevice) {
                if (receiverSelector?.isOpen && instance.contentContext) {
                    receiverSelector.pageInfo = {
                        ...instance.contentContext,
                        url: (await browser.webNavigation.getFrame({ tabId: instance.contentContext?.tabId, frameId: instance.contentContext?.frameId })).url
                    };
                }
                if (!instance.isTrusted) { logger.error("Cast instance not trusted to bypass receiver selection!"); destroyCastInstance(instance); break; }
                const session = await createCastSession({ instance, deviceId: receiverDevice.id, appId: sessionRequest.appId });
                session.bridgePort.postMessage({
                    subject: "bridge:createCastSession",
                    data: { appId: sessionRequest.appId, receiverDevice, customMediaUrl: (message.data as any).customMediaUrl, audioOnly: (message.data as any).audioOnly }
                });
                break;
            }
            try {
                const selection = await getReceiverSelection({ castInstance: instance });
                if (!selection) { instance.contentPort.postMessage({ subject: "cast:sessionRequestCancelled" }); break; }
                if (selection.mediaType !== ReceiverSelectorMediaType.App) {
                    instance.contentPort.postMessage({ subject: "cast:sessionRequestCancelled" });
                    if (!instance.contentContext) throw logger.error("Missing content context");
                    loadSender(selection, instance.contentContext);
                    break;
                }
                instance.contentPort.postMessage({
                    subject: "cast:receiverAction",
                    data: { receiver: createReceiver(selection.device), action: ReceiverAction.CAST }
                });
                const session = await createCastSession({ instance, deviceId: selection.device.id, appId: sessionRequest.appId });
                session.bridgePort.postMessage({
                    subject: "bridge:createCastSession",
                    data: { appId: sessionRequest.appId, receiverDevice: selection.device }
                });
            } catch (err) {
                instance.contentPort.postMessage({ subject: "cast:sessionRequestCancelled" });
            }
            break;
        }
        case "main:requestSessionById": {
            const session = activeSessions.get(message.data.sessionId);
            if (!session) { logger.log(`Session not found! (id: ${message.data.sessionId})`); break; }
            if (instance.apiConfig?.sessionRequest.appId === session.appId) {
                joinSession(instance, session);
                if (instance.contentContext) session.autoJoinContexts.add(instance.contentContext);
            }
            break;
        }
        case "main:leaveSession": {
            if (!instance.contentContext || !instance.session?.sessionId) { logger.error("Cannot leave session, instance invalid!"); break; }
            const target = findAutoJoinTarget(instance);
            if (target) {
                instance.session.autoJoinContexts.delete(target.autoJoinContext);
                const sessionAppId = instance.session.appId;
                leaveSession(instance);
                for (const activeInstance of activeInstances) {
                    if ((activeInstance === instance || activeInstance.session?.appId) !== sessionAppId) continue;
                    if (isValidAutoJoinContext(activeInstance, target.autoJoinContext)) leaveSession(activeInstance);
                }
            } else {
                leaveSession(instance);
            }
        }
    }
}

async function loadSender(selection: ReceiverSelection, contentContext: ContentContext) {
    if (!selection) return;
    switch (selection.mediaType) {
        case ReceiverSelectorMediaType.App: {
            const instance = castManager.getInstanceAt(contentContext.tabId, contentContext.frameId);
            if (!instance) throw logger.error(`Cast instance not found at tabId ${contentContext.tabId} / frameId ${contentContext.frameId}`);
            if (!instance.apiConfig?.sessionRequest.appId) throw logger.error("Invalid session request");
            instance.contentPort.postMessage({
                subject: "cast:receiverAction",
                data: { receiver: createReceiver(selection.device), action: ReceiverAction.CAST }
            });
            const session = await createCastSession({ instance, deviceId: selection.device.id });
            session.bridgePort.postMessage({
                subject: "bridge:createCastSession",
                data: { appId: session.appId, receiverDevice: selection.device }
            });
            break;
        }
        case ReceiverSelectorMediaType.Screen:
            await createMirroringPopup(selection.device);
            break;
    }
}

async function getReceiverSelection(selectionOpts: { tabId?: number; frameId?: number; castInstance?: CastInstance; }): Promise<ReceiverSelection | null> {
    if (selectionOpts.castInstance?.apiConfig?.sessionRequest.appId === (await options.get("mirroringAppId"))) selectionOpts.castInstance = undefined;
    let defaultMediaType = ReceiverSelectorMediaType.Screen;
    let availableMediaTypes = ReceiverSelectorMediaType.Screen;
    if (selectionOpts.frameId === undefined) selectionOpts.frameId = 0;
    if (selectionOpts.tabId === undefined && selectionOpts.castInstance?.contentContext) {
        selectionOpts.tabId = selectionOpts.castInstance.contentContext.tabId;
        selectionOpts.frameId = selectionOpts.castInstance.contentContext.frameId;
    }
    const opts = await options.getAll();
    if (!selectionOpts.castInstance && selectionOpts.tabId !== undefined && selectionOpts.frameId !== undefined) {
        const contextInstance = castManager.getInstanceAt(selectionOpts.tabId, selectionOpts.frameId);
        if (!contextInstance?.isTrusted) selectionOpts.castInstance = contextInstance;
    }
    let pageInfo: Optional<ReceiverSelectorPageInfo>;
    if (selectionOpts.tabId !== undefined) {
        try {
            pageInfo = { tabId: selectionOpts.tabId, frameId: selectionOpts.frameId, url: (await browser.webNavigation.getFrame({ tabId: selectionOpts.tabId, frameId: selectionOpts.frameId })).url };
        } catch (err) { logger.error("Failed to locate frame!", err); }
    }
    let appInfo: Optional<ReceiverSelectorAppInfo>;
    if (selectionOpts.castInstance?.apiConfig) {
        if (!baseConfig) {
            try { ({ baseConfig } = await baseConfigStorage.get("baseConfig")); } catch (err) { throw logger.error("Failed to get Chromecast base config!"); }
        }
        appInfo = {
            sessionRequest: selectionOpts.castInstance.apiConfig.sessionRequest,
            isRequestAppAudioCompatible: getAppTag(baseConfig, selectionOpts.castInstance.apiConfig?.sessionRequest.appId)?.supports_audio_only
        };
        defaultMediaType = ReceiverSelectorMediaType.App;
        availableMediaTypes |= ReceiverSelectorMediaType.App;
    }
    if (!opts.mirroringEnabled) availableMediaTypes &= ~ReceiverSelectorMediaType.Screen;

    await deviceManager.init();
    return new Promise(async (resolve, reject) => {
        if (receiverSelector?.isOpen) await receiverSelector.close();
        receiverSelector = createSelector();
        const onSelected = (ev: CustomEvent<ReceiverSelection>) => resolve(ev.detail);
        receiverSelector.addEventListener("selected", onSelected);
        const onCancelled = () => resolve(null);
        receiverSelector.addEventListener("cancelled", onCancelled);
        const onError = (ev: CustomEvent<string>) => reject(ev.detail);
        receiverSelector.addEventListener("error", onError);
        receiverSelector.addEventListener("close", () => {
            receiverSelector?.removeEventListener("selected", onSelected);
            receiverSelector?.removeEventListener("cancelled", onCancelled);
            receiverSelector?.removeEventListener("error", onError);
        }, { once: true });
        receiverSelector.open({ devices: deviceManager.getDevices(), defaultMediaType, availableMediaTypes, appInfo, pageInfo });
    });
}

function createSelector() {
    const selector = new ReceiverSelector(deviceManager.getBridgeInfo()?.isVersionCompatible ?? false);
    const onStop = (ev: CustomEvent<{ deviceId: string }>) => {
        const castInstance = castManager.getInstanceByDeviceId(ev.detail.deviceId);
        if (!castInstance) return;
        const device = deviceManager.getDeviceById(ev.detail.deviceId);
        if (!device) return;
        castInstance.contentPort.postMessage({
            subject: "cast:receiverAction",
            data: { receiver: createReceiver(device), action: ReceiverAction.STOP }
        });
    };
    selector.addEventListener("stop", onStop);
    const onReceiverMessage = (ev: CustomEvent<ReceiverSelectorReceiverMessage>) => deviceManager.sendReceiverMessage(ev.detail.deviceId, ev.detail.message);
    selector.addEventListener("receiverMessage", onReceiverMessage);
    const onMediaMessage = (ev: CustomEvent<ReceiverSelectorMediaMessage>) => deviceManager.sendMediaMessage(ev.detail.deviceId, ev.detail.message);
    selector.addEventListener("mediaMessage", onMediaMessage);

    const onDeviceChange = () => {
        const connectedSessionIds: string[] = [];
        for (const instance of activeInstances) {
            if (instance.session?.sessionId) connectedSessionIds.push(instance.session.sessionId);
        }
        selector.update(deviceManager.getDevices(), deviceManager.getBridgeInfo()?.isVersionCompatible ?? false, connectedSessionIds);
    };

    deviceManager.addEventListener("deviceUp", onDeviceChange);
    deviceManager.addEventListener("deviceDown", onDeviceChange);
    deviceManager.addEventListener("deviceUpdated", onDeviceChange);
    deviceManager.addEventListener("deviceMediaUpdated", onDeviceChange);

    selector.addEventListener("close", () => {
        deviceManager.removeEventListener("deviceUp", onDeviceChange);
        deviceManager.removeEventListener("deviceDown", onDeviceChange);
        deviceManager.removeEventListener("deviceUpdated", onDeviceChange);
        deviceManager.removeEventListener("deviceMediaUpdated", onDeviceChange);
        selector.removeEventListener("stop", onStop);
        selector.removeEventListener("receiverMessage", onReceiverMessage);
        selector.removeEventListener("mediaMessage", onMediaMessage);
    }, { once: true });
    return selector;
}

async function createMirroringPopup(device: ReceiverDevice) {
    let popup: browser.windows.Window;
    try {
        popup = await browser.windows.create({
            url: browser.runtime.getURL("ui/mirroring/index.html"),
            type: "popup", width: 400, height: 150
        });
    } catch (err) {
        logger.error("Failed to create mirroring popup!", err);
        return;
    }
    
    const onMirroringPopupMessage = (port: Port) => {
        if (port.sender?.tab?.windowId !== popup.id || port.name !== "mirroring") return;
        
        port.postMessage({ subject: "mirroringPopup:init", data: { device } });
        
        port.onMessage.addListener(async (msg: Message) => {
            if (msg.subject === "mirroringPopup:stop" || msg.subject === "mirroringPopup:close") {
                const bridgePort = await bridge.connect();
                bridgePort.postMessage({
                    subject: "bridge:sendCastReceiverMessage",
                    data: {
                        deviceId: device.id,
                        message: { type: "STOP", requestId: 0, sessionId: device.status?.applications?.[0]?.sessionId }
                    }
                });
                
                if (popup.id !== undefined) {
                    browser.windows.remove(popup.id).catch(() => {});
                }
            }
        });
    };
    messaging.onConnect.addListener(onMirroringPopupMessage);

    const onDeviceUpdated = () => {
        const updatedDevice = deviceManager.getDeviceById(device.id);
        const app = updatedDevice?.status?.applications?.[0];
        if (!app || app.isIdleScreen) {
            if (popup.id !== undefined) {
                browser.windows.remove(popup.id).catch(() => {});
            }
        }
    };
    deviceManager.addEventListener("deviceUpdated", onDeviceUpdated);

    browser.windows.onRemoved.addListener(function onWindowRemoved(windowId) {
        if (windowId !== popup.id) return;
        messaging.onConnect.removeListener(onMirroringPopupMessage);
        deviceManager.removeEventListener("deviceUpdated", onDeviceUpdated);
        browser.windows.onRemoved.removeListener(onWindowRemoved);
    });
}
