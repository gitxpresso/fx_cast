import pageMessaging from "./pageMessaging";
import CastSDK from "./sdk";

// Create page-accessible API object
window.chrome.cast = new CastSDK();

// Initialize the port to the background script
const port = browser.runtime.connect({ name: "cast" });

pageMessaging.page.addListener(async message => {
    switch (message.subject) {
        case "cast:instanceCreated": {
            const initFn = window.__onGCastApiAvailable;
            if (initFn && typeof initFn === "function") {
                initFn(message.data.isAvailable);
            }
            break;
        }
    }
});

// --- NEW FUNCTIONALITY: PiP, Audio Routing, and Playback Speed ---
// Listen for direct control messages sent from the extension popup
browser.runtime.onMessage.addListener((message: any) => {
    const video = document.querySelector("video");
    if (!video) return;

    if (message.subject === "cast:triggerPiP") {
        if (document.pictureInPictureEnabled) {
            if (document.pictureInPictureElement) {
                document.exitPictureInPicture().catch(() => {});
            } else {
                video.requestPictureInPicture().catch(() => {});
            }
        }
    } 
    else if (message.subject === "cast:setAudioSink") {
        if (typeof (video as any).setSinkId === "function") {
            navigator.mediaDevices.enumerateDevices().then(devices => {
                const audioOutputs = devices.filter(d => d.kind === 'audiooutput');
                if (audioOutputs.length > 1) {
                    const current = (video as any).sinkId;
                    // Cycle to the next available audio output device
                    const nextDevice = audioOutputs.find(d => d.deviceId !== current && d.deviceId !== "") || audioOutputs[0];
                    (video as any).setSinkId(nextDevice.deviceId).catch(() => {});
                }
            });
        }
    }
    else if (message.subject === "cast:setPlaybackRate") {
        video.playbackRate = message.data.rate;
    }
});
