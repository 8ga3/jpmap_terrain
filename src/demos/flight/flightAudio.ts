/**
 * フライトデモ SE 管理モジュール (Issue #269)
 *
 * Babylon.js 9.x AudioV2 API を使用して、followモードでの
 * エンジン音ループとウェイポイント通過SEを管理する。
 */
import { CreateAudioEngineAsync } from "@babylonjs/core/AudioV2/webAudio/webAudioEngine";
import { CreateSoundAsync } from "@babylonjs/core/AudioV2/abstractAudio/audioEngineV2";
import type { AudioEngineV2 } from "@babylonjs/core/AudioV2/abstractAudio/audioEngineV2";
import type { StaticSound } from "@babylonjs/core/AudioV2/abstractAudio/staticSound";
import { SoundState } from "@babylonjs/core/AudioV2/soundState";

import planeNoiseUrl from "../../../assets/plane-noise.mp3";
import planeWpUrl from "../../../assets/plane-wp.mp3";

/** SE 管理インターフェース */
export interface FlightAudio {
    startEngineSound(): void;
    stopEngineSound(): void;
    playWaypointPassSound(): void;
    dispose(): void;
}

/**
 * FlightAudio を生成する。
 * AudioEngine の初期化と unlockAsync を含むため、ユーザー操作起点で呼ぶこと。
 */
export const createFlightAudio = async (): Promise<FlightAudio> => {
    let engine: AudioEngineV2 | null = null;
    let engineSound: StaticSound | null = null;
    let wpSound: StaticSound | null = null;

    try {
        engine = await CreateAudioEngineAsync();
        await engine.unlockAsync();

        engineSound = await CreateSoundAsync(
            "plane-noise",
            planeNoiseUrl,
            { loop: true, volume: 0.4, autoplay: false },
            engine,
        );

        wpSound = await CreateSoundAsync(
            "plane-wp",
            planeWpUrl,
            { loop: false, volume: 0.8, maxInstances: 4 },
            engine,
        );
    } catch (err) {
        engineSound?.stop();
        engineSound?.dispose();
        wpSound?.stop();
        wpSound?.dispose();
        engine?.dispose();
        throw err;
    }

    return {
        startEngineSound: (): void => {
            if (
                engineSound.state !== SoundState.Started &&
                engineSound.state !== SoundState.Starting
            ) {
                engineSound.play();
            }
        },
        stopEngineSound: (): void => {
            if (
                engineSound.state === SoundState.Started ||
                engineSound.state === SoundState.Starting
            ) {
                engineSound.stop();
            }
        },
        playWaypointPassSound: (): void => {
            wpSound.play();
        },
        dispose: (): void => {
            engineSound.stop();
            wpSound.stop();
            engineSound.dispose();
            wpSound.dispose();
            engine.dispose();
        },
    };
};
