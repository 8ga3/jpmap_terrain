export interface GuardedVersionChange {
    key: string;
    before: string | null;
    after: string | null;
}

export declare const CONFIRMATION_PHRASE: string;

export declare const CONFIRMATION_TEMPLATE: string;

export declare function extractGuardedVersions(lockfile: unknown): Map<string, string | null>;

export declare function diffGuardedVersions(
    baseLockfile: unknown,
    headLockfile: unknown,
): GuardedVersionChange[];

export declare function hasVisualsConfirmation(body: unknown): boolean;
