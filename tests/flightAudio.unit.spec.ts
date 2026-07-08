/**
 * `src/demos/flight/flightAudio.ts` の unit test。
 *
 * AudioV2 API (CreateAudioEngineAsync / CreateSoundAsync) と
 * .mp3 import をモックして、初期化成功/失敗・SE 再生・停止・dispose を検証する。
 *
 * ESM + vi.mock で完全にモジュールを分離して
 * 他テストとのキャッシュ衝突を回避する。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// SoundState の数値定数（実装と一致させる）
const SoundState = {
    Stopping: 0,
    Stopped: 1,
    Starting: 2,
    Started: 3,
    FailedToStart: 4,
    Paused: 5,
} as const;

// ─── モック ──────────────────────────────────────────────

const mockEngineDispose = vi.fn();
const mockUnlockAsync = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockEngine = {
    unlockAsync: mockUnlockAsync,
    dispose: mockEngineDispose,
};

const makeSound = (initialState: number = SoundState.Stopped) => ({
    state: initialState,
    play: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
});

const mockCreateAudioEngineAsync = vi.fn<() => Promise<typeof mockEngine>>()
    .mockResolvedValue(mockEngine);

type MockSound = ReturnType<typeof makeSound>;
const mockCreateSoundAsync = vi.fn<() => Promise<MockSound>>();

vi.mock("@babylonjs/core/AudioV2/webAudio/webAudioEngine", () => ({
    CreateAudioEngineAsync: mockCreateAudioEngineAsync,
}));

vi.mock("@babylonjs/core/AudioV2/abstractAudio/audioEngineV2", () => ({
    CreateSoundAsync: mockCreateSoundAsync,
}));

vi.mock("@babylonjs/core/AudioV2/soundState", () => ({
    SoundState,
}));

// ─── テスト ──────────────────────────────────────────────

describe("createFlightAudio", () => {
    let createFlightAudio: typeof import("../src/demos/flight/flightAudio").createFlightAudio;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockUnlockAsync.mockResolvedValue(undefined);
        mockCreateAudioEngineAsync.mockResolvedValue(mockEngine);
        mockCreateSoundAsync.mockResolvedValue(makeSound());
        const mod = await import("../src/demos/flight/flightAudio");
        createFlightAudio = mod.createFlightAudio;
    });

    describe("初期化成功", () => {
        it("エンジン音・通過SEを作成して FlightAudio を返す", async () => {
            const engineSound = makeSound();
            const wpSound = makeSound();
            mockCreateSoundAsync
                .mockResolvedValueOnce(engineSound)
                .mockResolvedValueOnce(wpSound);

            const audio = await createFlightAudio();
            expect(audio).toBeDefined();
            expect(typeof audio.startEngineSound).toBe("function");
            expect(typeof audio.stopEngineSound).toBe("function");
            expect(typeof audio.playWaypointPassSound).toBe("function");
            expect(typeof audio.dispose).toBe("function");
        });

        it("startEngineSound: Stopped 状態なら play() を呼ぶ", async () => {
            const engineSound = makeSound(SoundState.Stopped);
            const wpSound = makeSound();
            mockCreateSoundAsync
                .mockResolvedValueOnce(engineSound)
                .mockResolvedValueOnce(wpSound);

            const audio = await createFlightAudio();
            audio.startEngineSound();
            expect(engineSound.play).toHaveBeenCalledTimes(1);
        });

        it("startEngineSound: Started 状態なら play() を呼ばない", async () => {
            const engineSound = makeSound(SoundState.Started);
            const wpSound = makeSound();
            mockCreateSoundAsync
                .mockResolvedValueOnce(engineSound)
                .mockResolvedValueOnce(wpSound);

            const audio = await createFlightAudio();
            audio.startEngineSound();
            expect(engineSound.play).not.toHaveBeenCalled();
        });

        it("startEngineSound: Starting 状態なら play() を呼ばない（重複再生防止）", async () => {
            const engineSound = makeSound(SoundState.Starting);
            const wpSound = makeSound();
            mockCreateSoundAsync
                .mockResolvedValueOnce(engineSound)
                .mockResolvedValueOnce(wpSound);

            const audio = await createFlightAudio();
            audio.startEngineSound();
            expect(engineSound.play).not.toHaveBeenCalled();
        });

        it("stopEngineSound: Started 状態なら stop() を呼ぶ", async () => {
            const engineSound = makeSound(SoundState.Started);
            const wpSound = makeSound();
            mockCreateSoundAsync
                .mockResolvedValueOnce(engineSound)
                .mockResolvedValueOnce(wpSound);

            const audio = await createFlightAudio();
            audio.stopEngineSound();
            expect(engineSound.stop).toHaveBeenCalledTimes(1);
        });

        it("stopEngineSound: Starting 状態でも stop() を呼ぶ（follow 離脱時キャンセル）", async () => {
            const engineSound = makeSound(SoundState.Starting);
            const wpSound = makeSound();
            mockCreateSoundAsync
                .mockResolvedValueOnce(engineSound)
                .mockResolvedValueOnce(wpSound);

            const audio = await createFlightAudio();
            audio.stopEngineSound();
            expect(engineSound.stop).toHaveBeenCalledTimes(1);
        });

        it("stopEngineSound: Stopped 状態なら stop() を呼ばない", async () => {
            const engineSound = makeSound(SoundState.Stopped);
            const wpSound = makeSound();
            mockCreateSoundAsync
                .mockResolvedValueOnce(engineSound)
                .mockResolvedValueOnce(wpSound);

            const audio = await createFlightAudio();
            audio.stopEngineSound();
            expect(engineSound.stop).not.toHaveBeenCalled();
        });

        it("playWaypointPassSound: wpSound.play() を常に呼ぶ", async () => {
            const engineSound = makeSound();
            const wpSound = makeSound();
            mockCreateSoundAsync
                .mockResolvedValueOnce(engineSound)
                .mockResolvedValueOnce(wpSound);

            const audio = await createFlightAudio();
            audio.playWaypointPassSound();
            audio.playWaypointPassSound();
            expect(wpSound.play).toHaveBeenCalledTimes(2);
        });

        it("dispose: engineSound・wpSound・engine を stop/dispose する", async () => {
            const engineSound = makeSound(SoundState.Started);
            const wpSound = makeSound();
            mockCreateSoundAsync
                .mockResolvedValueOnce(engineSound)
                .mockResolvedValueOnce(wpSound);

            const audio = await createFlightAudio();
            audio.dispose();

            expect(engineSound.stop).toHaveBeenCalled();
            expect(engineSound.dispose).toHaveBeenCalled();
            expect(wpSound.stop).toHaveBeenCalled();
            expect(wpSound.dispose).toHaveBeenCalled();
            expect(mockEngineDispose).toHaveBeenCalled();
        });
    });

    describe("初期化失敗時のリソースクリーンアップ", () => {
        it("unlockAsync が失敗: engine が dispose されて re-throw する", async () => {
            mockUnlockAsync.mockRejectedValueOnce(new Error("unlock failed"));

            await expect(createFlightAudio()).rejects.toThrow("unlock failed");
            expect(mockEngineDispose).toHaveBeenCalledTimes(1);
        });

        it("1つ目の CreateSoundAsync が失敗: engine が dispose されて re-throw する", async () => {
            const error = new Error("sound load failed");
            mockCreateSoundAsync.mockRejectedValueOnce(error);

            await expect(createFlightAudio()).rejects.toThrow("sound load failed");
            expect(mockEngineDispose).toHaveBeenCalledTimes(1);
        });

        it("2つ目の CreateSoundAsync が失敗: engineSound・engine が dispose されて re-throw する", async () => {
            const engineSound = makeSound();
            const error = new Error("wp sound load failed");
            mockCreateSoundAsync
                .mockResolvedValueOnce(engineSound)
                .mockRejectedValueOnce(error);

            await expect(createFlightAudio()).rejects.toThrow("wp sound load failed");
            expect(engineSound.stop).toHaveBeenCalled();
            expect(engineSound.dispose).toHaveBeenCalled();
            expect(mockEngineDispose).toHaveBeenCalledTimes(1);
        });
    });
});
