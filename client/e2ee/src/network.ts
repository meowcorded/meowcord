export class EncryptionNetworkError extends Error {
    constructor(readonly cause: unknown) {
        super("Encryption couldn't reach the server", {cause});
    }
}

export const requestFailure = (error: unknown) => {
    const status = (error as { status?: unknown } | null)?.status;
    return typeof status === "number" && status > 0 ? error : new EncryptionNetworkError(error);
};

export const isTransientRequestError = (error: unknown) => {
    if (error instanceof EncryptionNetworkError) return true;
    const status = (error as { status?: unknown } | null)?.status;
    return typeof status === "number" && (status === 0 || status === 408 || status === 429 || status >= 500);
};