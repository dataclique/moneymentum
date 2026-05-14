/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_REOWN_PROJECT_ID?: string
  /** Default recipient address for the USDC demo form. */
  readonly VITE_SOLANA_TRANSFER_RECIPIENT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
