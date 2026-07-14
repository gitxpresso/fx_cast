<script lang="ts">
    import { createEventDispatcher, onMount } from "svelte";
    import fuzzysort from "fuzzysort";

    import type { Options } from "../../lib/options";
    import {
        type ReceiverDevice,
        ReceiverDeviceCapabilities
    } from "../../types";
    import type { Port } from "../../messaging";

    import { MenuId } from "../../menuIds";

    import type { Volume } from "../../cast/sdk/classes";
    import { PlayerState, TrackType } from "../../cast/sdk/media/enums";
    import type {
        SenderMediaMessage,
        SenderMessage
    } from "../../cast/sdk/types";
    import { _MediaCommand } from "../../cast/sdk/types";

    import LoadingIndicator from "../LoadingIndicator.svelte";
    import ReceiverMedia from "./ReceiverMedia.svelte";

    const _ = browser.i18n.getMessage;
    const dispatch = createEventDispatcher<{
        cast: { device: ReceiverDevice };
        stop: { device: ReceiverDevice };
    }>();

    export let port: Nullable<Port>;

    /** Whether there are sessions being established for any receiver. */
    export let isAnyConnecting: boolean;
    /** Whether the selected media type is available for this receiver. */
    export let isMediaTypeAvailable: boolean;
    /** Whether any media types are available for this receiver. */
    export let isAnyMediaTypeAvailable: boolean;

    /** Device to display. */
    export let device: ReceiverDevice;
    export let connectedSessionIds: string[];

    /** Result object if this receiver is displayed in a search results list. */
    export let result: Nullable<Fuzzysort.KeyResult<ReceiverDevice>> = null;

    export let opts: Nullable<Options>;
    /** Current receiver application (if available) */
    $: application = device.status?.applications?.[0];
    /** Current media status (if available) */
    $: mediaStatus = device.mediaStatus;

    export let lastMenuShownDeviceId: string;
    $: if (lastMenuShownDeviceId === device.id) {
        void device.mediaStatus;
        updateMediaMenus();
        browser.menus.refresh();
    }

    const languageNames = new Intl.DisplayNames(
        [browser.i18n.getUILanguage()],
        { type: "language" }
    );
    // Subtitle/caption tracks
    $: textTracks = mediaStatus?.media?.tracks
        ?.filter(track => track.type === TrackType.TEXT)
        .map(track => {
            if (!track.name && track.language) {
                try {
                    const displayName = languageNames.of(track.language);
                    if (displayName) {
                        track.name = displayName;
                    }
                } catch (err) {}
            }
            return track;
        });
    $: activeTextTrackId = mediaStatus?.activeTrackIds?.find(trackId =>
        textTracks?.find(track => track.trackId === trackId)
    );
    
    /** Whether media controls are shown. */
    let isExpanded = false;
    let isExpandedUserModified = false;
    
    // Unexpand if media status disappears
    $: if (!device.mediaStatus) {
        isExpanded = false;
    } else if (
        application &&
        !isExpandedUserModified &&
        opts?.receiverSelectorExpandActive
    ) {
        isExpanded = connectedSessionIds.includes(application.transportId);
    }

    /** Whether a session request is in progress for this receiver.. */
    let isConnecting = false;

    // --- SMART SLEEP TIMER LOGIC (WITH PRESETS) ---
    let sleepTimerMinutes = 0;
    let sleepTimerActive = false;
    let sleepTimerInterval: any;
    
    const sleepPresets = [0, 15, 30, 60, 120]; // 0 is Off
    let currentPresetIndex = 0;

    function toggleSleepTimer() {
        currentPresetIndex = (currentPresetIndex + 1) % sleepPresets.length;
        const preset = sleepPresets[currentPresetIndex];
        
        clearInterval(sleepTimerInterval);
        
        if (preset === 0) {
            sleepTimerActive = false;
            sleepTimerMinutes = 0;
        } else {
            sleepTimerActive = true;
            sleepTimerMinutes = preset;
            startSleepCountdown();
        }
    }

    function setCustomSleepTimer() {
        const input = prompt("Enter exact sleep timer in minutes (e.g. 45):", "45");
        if (!input) return;
        
        const mins = parseInt(input, 10);
        if (isNaN(mins) || mins <= 0) return;
        
        clearInterval(sleepTimerInterval);
        sleepTimerMinutes = mins;
        sleepTimerActive = true;
        currentPresetIndex = -1; // Denotes custom value
        startSleepCountdown();
    }

    function startSleepCountdown() {
        sleepTimerInterval = setInterval(() => {
            sleepTimerMinutes -= 1;
            if (sleepTimerMinutes <= 0) {
                clearInterval(sleepTimerInterval);
                sleepTimerActive = false;
                dispatch("stop", { device }); // Force stop when timer hits zero!
            }
        }, 60000);
    }
    // ------------------------------------
    
    function sendReceiverMessage(
        partialMessage: DistributiveOmit<SenderMessage, "requestId">
    ) {
        const message: SenderMessage = {
            ...partialMessage,
            requestId: 0
        };
        port?.postMessage({
            subject: "main:sendReceiverMessage",
            data: { deviceId: device.id, message }
        });
    }
    
    function sendMediaMessage(
        partialMessage: DistributiveOmit<
            SenderMediaMessage,
            "requestId" | "mediaSessionId"
        >
    ) {
        if (!device.mediaStatus) return;
        const message: SenderMediaMessage = {
            ...(partialMessage as any),
            requestId: 0,
            mediaSessionId: device.mediaStatus.mediaSessionId
        };
        port?.postMessage({
            subject: "main:sendMediaMessage",
            data: { deviceId: device.id, message }
        });
    }

    let receiverElement: HTMLLIElement;
    function isTarget(
        info?: browser.menus._OnShownInfo | browser.menus.OnClickData
    ) {
        if (info?.pageUrl !== window.location.href) return false;
        if (!info.targetElementId) return false;
        const targetElement = browser.menus.getTargetElement(
            info.targetElementId
        );
        if (!targetElement) return false;

        return (
            targetElement === receiverElement ||
            receiverElement.contains(targetElement)
        );
    }

    const captionSubmenus = new Map<number | string, number>();

    function onMenuShown(info: browser.menus._OnShownInfo) {
        if (!isTarget(info)) {
            return;
        }

        lastMenuShownDeviceId = device.id;
        browser.menus.update(MenuId.PopupCast, {
            visible: true,
            title: _("popupCastMenuTitle", device.friendlyName),
            enabled:
                !isConnecting &&
                !isAnyConnecting &&
                isMediaTypeAvailable &&
                isAnyMediaTypeAvailable
        });
        browser.menus.update(MenuId.PopupStop, {
            visible: !!application && !application.isIdleScreen,
            title: application?.displayName
                ? _("popupStopMenuTitle", [
                      application.displayName,
                      device.friendlyName
                  ])
                : ""
        });
        updateMediaMenus(info.menuIds as (string | number)[]);
        browser.menus.refresh();
    }

    function handleMediaPlayPause() {
        switch (mediaStatus?.playerState) {
            case PlayerState.PLAYING:
                sendMediaMessage({ type: "PAUSE" });
                break;
            case PlayerState.PAUSED:
                sendMediaMessage({ type: "PLAY" });
                break;
        }
    }
    function handleMediaSkipPrevious() {
        sendMediaMessage({
            type: "QUEUE_UPDATE",
            jump: -1
        });
    }
    function handleMediaSkipNext() {
        sendMediaMessage({
            type: "QUEUE_UPDATE",
            jump: 1
        });
    }
    function handleMediaTrackChange(activeTrackIds: number[]) {
        sendMediaMessage({
            type: "EDIT_TRACKS_INFO",
            activeTrackIds: activeTrackIds
        });
    }
    function handleVolumeChange(volume: Partial<Volume>) {
        sendReceiverMessage({
            type: "SET_VOLUME",
            volume
        });
    }

    function onMenuClicked(info: browser.menus.OnClickData) {
        if (!isTarget(info)) return;
        switch (info.menuItemId) {
            case MenuId.PopupMediaPlayPause:
                handleMediaPlayPause();
                break;
            case MenuId.PopupMediaMute:
                if (
                    !device.status?.volume?.muted &&
                    device.status?.volume?.level === 0
                ) {
                    handleVolumeChange({ level: 1 });
                } else {
                    handleVolumeChange({ muted: !device.status?.volume?.muted });
                }
                break;
            case MenuId.PopupMediaSkipPrevious:
                handleMediaSkipPrevious();
                break;
            case MenuId.PopupMediaSkipNext:
                handleMediaSkipNext();
                break;
            case MenuId.PopupCast:
                isConnecting = true;
                dispatch("cast", { device });
                break;
            case MenuId.PopupStop:
                dispatch("stop", { device });
                break;
        }

        if (info.parentMenuItemId === MenuId.PopupMediaCaptions) {
            if (!mediaStatus?.activeTrackIds) return;
            const activeTrackIds = mediaStatus.activeTrackIds.filter(
                activeTrackId => activeTrackId !== activeTextTrackId
            );
            const trackId = captionSubmenus.get(info.menuItemId);
            if (trackId) {
                activeTrackIds.push(trackId);
            }
            handleMediaTrackChange(activeTrackIds);
        }
    }

    function onContextMenu() {
        browser.menus.overrideContext({ showDefaults: false });
    }

    const mediaMenuIds = [
        MenuId.PopupMediaSeparator,
        MenuId.PopupMediaPlayPause,
        MenuId.PopupMediaMute,
        MenuId.PopupMediaSkipPrevious,
        MenuId.PopupMediaSkipNext,
        MenuId.PopupMediaCaptions
    ];
    
    function updateMediaMenus(shownMenuIds: (number | string)[] = []) {
        if (captionSubmenus.size) {
            for (const menuId of captionSubmenus.keys()) {
                browser.menus.remove(menuId);
            }
            captionSubmenus.clear();
        } else {
            for (const menuId of shownMenuIds as string[] | number[]) {
                if (
                    typeof menuId === "string" &&
                    menuId.startsWith("subtitle-")
                ) {
                    browser.menus.remove(menuId);
                }
            }
        }

        if (!mediaStatus) {
            for (const menuId of mediaMenuIds)
                browser.menus.update(menuId, { visible: false });
            return;
        }

        browser.menus.update(MenuId.PopupMediaSeparator, {
            visible: true
        });
        
        if (mediaStatus.supportedMediaCommands & _MediaCommand.PAUSE) {
            browser.menus.update(MenuId.PopupMediaPlayPause, {
                visible: true,
                title:
                    mediaStatus.playerState === PlayerState.PLAYING ||
                    mediaStatus.playerState === PlayerState.BUFFERING
                        ? _("popupMediaPause")
                        : _("popupMediaPlay"),
                enabled:
                    mediaStatus.playerState === PlayerState.PLAYING ||
                    mediaStatus.playerState === PlayerState.PAUSED
            });
        } else {
            browser.menus.update(MenuId.PopupMediaPlayPause, {
                visible: false
            });
        }

        if (device.status?.volume) {
            const volume = device.status.volume;
            browser.menus.update(MenuId.PopupMediaMute, {
                visible: true,
                title: _("popupMediaMute"),
                checked: volume.muted || volume.level === 0,
                enabled: "muted" in volume
            });
        } else {
            browser.menus.update(MenuId.PopupMediaMute, {
                visible: false
            });
        }

        browser.menus.update(MenuId.PopupMediaSkipPrevious, {
            visible: !!(
                mediaStatus.supportedMediaCommands & _MediaCommand.QUEUE_PREV
            )
        });
        browser.menus.update(MenuId.PopupMediaSkipNext, {
            visible: !!(
                mediaStatus.supportedMediaCommands & _MediaCommand.QUEUE_NEXT
            )
        });
        
        if (
            textTracks?.length &&
            mediaStatus.supportedMediaCommands & _MediaCommand.EDIT_TRACKS
        ) {
            browser.menus.update(MenuId.PopupMediaCaptions, { visible: true });
            browser.menus.update(MenuId.PopupMediaCaptionsOff, {
                visible: true,
                checked: activeTextTrackId === undefined
            });
            for (const track of textTracks) {
                const menuId = browser.menus.create({
                    id: `subtitle-${track.trackId}`,
                    title: track.name ?? track.trackId.toString(),
                    parentId: MenuId.PopupMediaCaptions,
                    type: "radio",
                    checked: track.trackId === activeTextTrackId
                });
                captionSubmenus.set(menuId, track.trackId);
            }
        } else {
            browser.menus.update(MenuId.PopupMediaCaptions, {
                visible: false
            });
        }
    }

    // --- ADVANCED CAST DASHBOARD VARIABLES ---
    let customUrl = "";
    let audioDevices: MediaDeviceInfo[] = [];
    let selectedAudioSink = "default";
    let isAudioOnly = false;

    function handleIPTVUpload(event: Event) {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (e) => {
            const text = e.target?.result as string;
            const match = text.match(/https?:\/\/[^\s]+/);
            if (match) {
                customUrl = match[0];
            } else {
                alert("No valid HTTP stream found in the IPTV file!");
            }
        };
        reader.readAsText(file);
    }

    function handleCustomCast() {
        // Validation to prevent infinite loading
        if (customUrl.startsWith("file://") || customUrl.startsWith("/")) {
            alert("Chromecasts are separate devices and cannot read local files directly from your hard drive!\n\nTo cast this video, drag the .mp4 file into a new Firefox tab, and then click the standard Cast button.");
            return;
        }
        if (!customUrl.startsWith("http")) {
            alert("Please enter a valid http:// or https:// URL!");
            return;
        }

        port?.postMessage({
            subject: "main:castCustomMedia",
            data: {
                receiverDevice: device,
                mediaUrl: customUrl
            }
        });
        isConnecting = true;

        // Failsafe timeout: Stop the spinner if the TV doesn't respond after 6 seconds
        setTimeout(() => {
            isConnecting = false;
        }, 6000);
    }

    function triggerPiP() {
        port?.postMessage({ subject: "main:triggerPiP" });
    }

    function applyAudioSink() {
         port?.postMessage({ subject: "main:setAudioSink", data: { sinkId: selectedAudioSink } });
    }

    onMount(async () => {
        sendMediaMessage({
            type: "GET_STATUS"
        });

        browser.menus.onShown.addListener(onMenuShown);
        browser.menus.onClicked.addListener(onMenuClicked);

        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            audioDevices = devices.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default');
        } catch (err) {}

        return () => {
            browser.menus.onShown.removeListener(onMenuShown);
            browser.menus.onClicked.removeListener(onMenuClicked);
        };
    });
</script>

<li
    class="receiver"
    class:receiver--result={!!result}
    bind:this={receiverElement}
    on:contextmenu={onContextMenu}
>
    <img
        class="receiver__icon"
        src="icons/{device.capabilities & ReceiverDeviceCapabilities.VIDEO_OUT
            ? 'device-video.svg'
            : 'device-audio.svg'}"
        alt=""
        height="24"
        width="24"
    />
    <div class="receiver__details">
        <div class="receiver__name">
            {#if result}
                {@html fuzzysort.highlight(result)}
            {:else}
                {device.friendlyName}
            {/if}
        </div>
        {#if application && !application.isIdleScreen}
            <div class="receiver__status">
                <span class="receiver__app-name">
                    {application.displayName}
                </span>
                {#if application.statusText !== application.displayName}
                    · {application.statusText}
                {/if}
            </div>
        {/if}
    </div>

    {#if application && !application.isIdleScreen}
        <button
            class="receiver__stop-button"
            on:click={() => dispatch("stop", { device })}
        >
            {_("popupStopButtonTitle")}
        </button>
    {:else if isAnyMediaTypeAvailable}
        <button
            class="receiver__cast-button"
            disabled={isConnecting || isAnyConnecting || !isMediaTypeAvailable}
            on:click={() => {
                isConnecting = true;
                dispatch("cast", { device });
            }}
        >
            {#if isConnecting}
                {_("popupCastingButtonTitle", "")}<LoadingIndicator />
            {:else}
                {_("popupCastButtonTitle")}
            {/if}
        </button>
    {/if}

    <button
        type="button"
        class="receiver__expand-button ghost"
        class:receiver__expand-button--expanded={isExpanded}
        title="Show Advanced Dashboard"
        on:click={() => {
            isExpanded = !isExpanded;
            isExpandedUserModified = true;
        }}
    />

    {#if isExpanded}
        <div class="receiver__expanded">
            <div class="advanced-cast-dashboard">
                <div class="dashboard-header">Smart Dashboard</div>
                
                {#if mediaStatus}
                    <div class="dashboard-section media-controls">
                        <ReceiverMedia
                            status={mediaStatus}
                            showImage={opts?.receiverSelectorShowMediaImages}
                            {device}
                            {textTracks}
                            on:togglePlayback={() => handleMediaPlayPause()}
                            on:previous={() => handleMediaSkipPrevious()}
                            on:next={() => handleMediaSkipNext()}
                            on:seek={ev => {
                                sendMediaMessage({
                                    type: "SEEK",
                                    currentTime: ev.detail.position
                                });
                            }}
                            on:trackChanged={ev =>
                                handleMediaTrackChange(ev.detail.activeTrackIds)}
                            on:volumeChanged={ev => handleVolumeChange(ev.detail)}
                        />
                    </div>
                {/if}

                <div class="dashboard-section">
                    <div class="section-title">TV Volume Control</div>
                    <div class="input-row">
                        <button class="ghost-btn" style="min-width: 40px; background: rgba(0,0,0,0.2)" on:click={() => handleVolumeChange({ muted: !device.status?.volume?.muted })}>
                            {device.status?.volume?.muted ? '🔇' : '🔊'}
                        </button>
                        <input
                            type="range"
                            class="slider custom-input"
                            style="margin: 0;"
                            step="0.05"
                            max="1"
                            value={device.status?.volume?.muted ? 0 : (device.status?.volume?.level || 0)}
                            on:change={ev => handleVolumeChange({ level: ev.currentTarget.valueAsNumber })}
                        />
                    </div>
                </div>

                <div class="dashboard-section">
                    <div class="section-title">1. Custom URL (.mp4, .m3u8, .mp3, etc.)</div>
                    <div class="input-row">
                        <input type="text" class="custom-input" placeholder="Paste http:// web video URL..." bind:value={customUrl} />
                        <label class="file-upload-btn" title="Upload IPTV Playlist">
                            📁
                            <input type="file" accept=".m3u8,.txt,.json,.mp4" hidden on:change={handleIPTVUpload} />
                        </label>
                    </div>
                    <button class="cast-action-btn" disabled={!customUrl} on:click={handleCustomCast}>Launch Custom Stream</button>
                </div>

                <div class="dashboard-section">
                    <div class="section-title">2. Split Audio (Local Headphone)</div>
                    <div class="input-row">
                        <select class="custom-input" bind:value={selectedAudioSink} on:change={applyAudioSink}>
                            <option value="default">Default System Audio</option>
                            {#each audioDevices as audioDev}
                                <option value={audioDev.deviceId}>{audioDev.label || 'Unknown Audio Device'}</option>
                            {/each}
                        </select>
                    </div>
                </div>

                <div class="dashboard-section toggle-section">
                    <label class="toggle-row" style="color: #00e676;" title="Automatically skips ads and sponsor segments!">
                        <input type="checkbox" checked disabled />
                        YouTube Ad & Sponsor Blocker (Active)
                    </label>
                    <label class="toggle-row">
                        <input type="checkbox" bind:checked={isAudioOnly} />
                        Audio-Only (Save Bandwidth)
                    </label>
                    <div class="action-buttons-row">
                        <button class="ghost-btn pip-btn" on:click={triggerPiP}>PiP Mode</button>
                        <div style="display: flex; gap: 4px; flex: 1;">
                            <button class="ghost-btn smart-btn" style="flex: 1; margin: 0;" class:active={sleepTimerActive} on:click={toggleSleepTimer}>
                                ⏳ {sleepTimerActive ? `Sleep: ${sleepTimerMinutes}m` : 'Sleep Timer'}
                            </button>
                            <button class="ghost-btn" style="width: 32px; border: 1px solid #555577; border-radius: 4px; color: #ccc; cursor: pointer; background: rgba(255,255,255,0.05);" title="Custom Timer" on:click={setCustomSleepTimer}>
                                ⚙️
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    {/if}
</li>
