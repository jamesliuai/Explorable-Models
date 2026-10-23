import type { ErrorCode, SerializedError } from './types.js';
const recoveries: Record<ErrorCode, string> = {
    INVALID_PARAMETER: 'Choose a value inside the parameter’s declared domain.',
    INVALID_MANIFEST: 'Correct the experiment manifest and build a new revision.',
    INVALID_COMMAND: 'Use the documented command schema.',
    OUT_OF_DOMAIN: 'Choose a time inside the model’s valid interval.',
    UNDEFINED_QUANTITY: 'Inspect the reason and change the parameters if appropriate.',
    CONFLICT: 'Inspect the current state and retry with its versions and active run ID.',
    BUSY: 'Wait for the active control gesture to be committed or cancelled.',
    INCOMPATIBLE_SNAPSHOT: 'Open the exact experiment revision referenced by this snapshot.',
    MODEL_ERROR: 'Correct the model source and check the candidate before activating it.',
    RESOURCE_LIMIT: 'Reduce the request size to the documented limit.',
    UNSUPPORTED_CAPABILITY: 'Use a capability advertised by this experiment.',
    NOT_FOUND: 'Inspect available experiment, run, entity, or quantity IDs.',
    TIMEOUT: 'Restart the model worker after fixing the nonresponsive evaluation.',
};
export class ExperimentError extends Error {
    readonly code: ErrorCode;
    readonly field?: string;
    readonly recovery: string;
    readonly currentVersion?: number;
    readonly currentActiveRunId?: string;
    constructor(code: ErrorCode, message: string, details: Partial<Omit<SerializedError, 'code' | 'message'>> = {}) {
        super(typeof message === 'string' ? message.slice(0, 8000) : 'Model execution failed.');
        this.name = 'ExperimentError';
        this.code = Object.hasOwn(recoveries, code) ? code : 'MODEL_ERROR';
        this.field = typeof details.field === 'string' ? details.field.slice(0, 200) : undefined;
        this.recovery = typeof details.recovery === 'string' ? details.recovery.slice(0, 4000) : recoveries[this.code];
        this.currentVersion = Number.isSafeInteger(details.currentVersion) && details.currentVersion! >= 0 ? details.currentVersion : undefined;
        this.currentActiveRunId = typeof details.currentActiveRunId === 'string' ? details.currentActiveRunId.slice(0, 200) : undefined;
    }
    toJSON(): SerializedError {
        return { code: this.code, message: this.message, recovery: this.recovery,
            ...(this.field === undefined ? {} : { field: this.field }),
            ...(this.currentVersion === undefined ? {} : { currentVersion: this.currentVersion }),
            ...(this.currentActiveRunId === undefined ? {} : { currentActiveRunId: this.currentActiveRunId }) };
    }
}
export function asExperimentError(error: unknown): ExperimentError {
    return error instanceof ExperimentError ? error : new ExperimentError('MODEL_ERROR', error instanceof Error ? error.message : 'Model execution failed.');
}
