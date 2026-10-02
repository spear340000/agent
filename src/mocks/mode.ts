const configuredMode = process.env.NEXT_PUBLIC_USE_MOCK_BACKEND

/** Use mock API data during local development unless explicitly disabled. */
export const MOCK_BACKEND_ENABLED =
  configuredMode === 'true' ||
  (configuredMode !== 'false' && process.env.NODE_ENV === 'development')
