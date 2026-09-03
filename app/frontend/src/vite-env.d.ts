/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_COGNITO_USER_POOL_ID: string
  readonly VITE_COGNITO_CLIENT_ID: string
  readonly VITE_COGNITO_IDENTITY_POOL_ID: string
  readonly VITE_S3_BUCKET: string
  readonly VITE_AWS_REGION: string
  readonly VITE_BACKEND_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// 3Dmol.js type declarations
declare const $3Dmol: {
  createViewer: (element: HTMLElement, config?: object) => any
  SurfaceType: {
    VDW: string
    MS: string
    SAS: string
    SES: string
  }
}