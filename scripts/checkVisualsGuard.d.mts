export interface GuardedVersionChange {
    key: string;
    before: string | null;
    after: string | null;
}

export declare const CONFIRMATION_PHRASE: string;

export declare function extractGuardedVersions(lockfile: unknown): Map<string, string | null>;

export declare function isSupportedLockfile(lockfile: unknown): boolean;

export declare function diffGuardedVersions(
    baseLockfile: unknown,
    headLockfile: unknown,
): GuardedVersionChange[];

export declare function computeGuardedFingerprint(lockfile: unknown): string;

export declare function formatConfirmationLine(fingerprint: string): string;

export declare function extractRenderedLines(body: string): string[];

export declare function findConfirmationFingerprints(body: unknown): string[];

export declare function hasVisualsConfirmation(body: unknown, fingerprint: string): boolean;
