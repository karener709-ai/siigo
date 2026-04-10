/** Errores de dominio con mensaje claro para logs; no fallar en silencio */
export class SyncError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'SyncError';
    Object.setPrototypeOf(this, SyncError.prototype);
  }
}

export class ConfigError extends SyncError {
  constructor(message: string, cause?: unknown) {
    super(message, 'CONFIG_ERROR', cause);
    this.name = 'ConfigError';
  }
}

export class SiigoError extends SyncError {
  constructor(message: string, cause?: unknown) {
    super(message, 'SIIGO_ERROR', cause);
    this.name = 'SiigoError';
  }
}

export class HubSpotError extends SyncError {
  constructor(message: string, cause?: unknown) {
    super(message, 'HUBSPOT_ERROR', cause);
    this.name = 'HubSpotError';
  }
}
