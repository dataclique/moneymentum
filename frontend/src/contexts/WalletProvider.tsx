import {
  createSignal,
  createMemo,
  onMount,
  onCleanup,
  untrack,
  type ParentProps,
} from "solid-js"
import {
  WalletContext,
  WALLET_STORAGE_KEY,
  NETWORK_STORAGE_KEY,
  getStoredEncryptedSession,
  getStoredNetworkMode,
  type EncryptedWalletSession,
  type NetworkMode,
  type WalletCredentials,
} from "./wallet-context"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import {
  WalletConnectError,
  WalletDisconnectFailed,
  WalletSessionMissing,
  type WalletUnlockFailure,
} from "@/services/wallet"
import type { HyperliquidClient } from "@/services/hyperliquid-client"
import {
  ensureHyperliquidClientModule,
  prefetchHyperliquidClientModule,
} from "@/services/hyperliquidClientLoader"
import {
  decryptWalletPrivateKey,
  encryptWalletPrivateKey,
} from "@/services/walletCredentialCrypto"
import {
  ensureEvmAppKit,
  readConnectedEip1193Provider,
} from "@/reown/evmAppKit"

const credentialsFromSession = (
  session: EncryptedWalletSession,
  privateKey: string,
): WalletCredentials => ({
  accountAddress: session.accountAddress,
  apiWalletAddress: session.apiWalletAddress,
  privateKey,
})

const persistEncryptedSession = (
  credentials: WalletCredentials,
  encrypted: Pick<
    EncryptedWalletSession,
    "encryptedPrivateKey" | "salt" | "iv"
  >,
) => {
  const session: EncryptedWalletSession = {
    accountAddress: credentials.accountAddress,
    apiWalletAddress: credentials.apiWalletAddress,
    encryptedPrivateKey: encrypted.encryptedPrivateKey,
    salt: encrypted.salt,
    iv: encrypted.iv,
  }
  localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(session))
}

const clearEncryptedSession = () => {
  localStorage.removeItem(WALLET_STORAGE_KEY)
}

const sameWalletAddress = (
  left: string | null | undefined,
  right: string | null | undefined,
): boolean => {
  if (
    left === null ||
    left === undefined ||
    right === null ||
    right === undefined
  ) {
    return false
  }

  return left.toLowerCase() === right.toLowerCase()
}

type HyperliquidClientConstructor =
  typeof import("@/services/hyperliquid-client").HyperliquidClient

export const WalletProvider = (props: ParentProps) => {
  const storedSession = getStoredEncryptedSession()
  const [mainAddress, setMainAddressState] = createSignal<string | null>(
    storedSession?.accountAddress ?? null,
  )
  const [credentials, setCredentials] = createSignal<WalletCredentials | null>(
    null,
  )
  const [networkMode, setNetworkModeState] = createSignal<NetworkMode>(
    getStoredNetworkMode(),
  )
  const [hasStoredSession, setHasStoredSession] = createSignal(
    storedSession !== null,
  )
  const [HyperliquidClientClass, setHyperliquidClientClass] =
    createSignal<HyperliquidClientConstructor | null>(null)

  const syncStoredSessionState = () => {
    setHasStoredSession(getStoredEncryptedSession() !== null)
  }

  const isConnected = createMemo(() => mainAddress() !== null)
  const isLocked = createMemo(
    () => hasStoredSession() && credentials() === null,
  )
  const canTrade = createMemo(() => credentials() !== null)

  const client = createMemo((): HyperliquidClient | null => {
    const Client = HyperliquidClientClass()
    if (Client === null) {
      return null
    }

    const unlocked = credentials()
    if (unlocked) {
      return new Client(unlocked, networkMode())
    }

    const address = mainAddress()
    if (!address) {
      return null
    }

    return new Client({ accountAddress: address }, networkMode())
  })

  const setMainAddress = (address: string | null) => {
    // Reown account callbacks are not Solid tracked scopes; read unlocked
    // credentials without subscribing so mismatch invalidation still runs.
    const unlocked = untrack(() => credentials())
    if (
      unlocked !== null &&
      !sameWalletAddress(unlocked.accountAddress, address)
    ) {
      setCredentials(null)
    }

    const stored = getStoredEncryptedSession()
    if (stored !== null && !sameWalletAddress(stored.accountAddress, address)) {
      clearEncryptedSession()
      syncStoredSessionState()
    }

    setMainAddressState(address)
  }

  const connect = (
    newCredentials: WalletCredentials,
    pin: string,
  ): Effect.Effect<void, WalletConnectError> =>
    Effect.tryPromise({
      try: () => encryptWalletPrivateKey(newCredentials.privateKey, pin),
      catch: cause => new WalletConnectError({ cause }),
    }).pipe(
      Effect.tap(encrypted =>
        Effect.sync(() => {
          persistEncryptedSession(newCredentials, encrypted)
          setMainAddressState(newCredentials.accountAddress)
          setCredentials(newCredentials)
          syncStoredSessionState()
        }),
      ),
      Effect.asVoid,
    )

  /**
   * Generate agent + encrypt with PIN, then Reown-signed approveAgent.
   * Persists the encrypted session only after approval succeeds.
   * On approve failure any leftover encrypted session is cleared.
   */
  const authorizeAgent = (
    pin: string,
  ): Effect.Effect<void, WalletConnectError> => {
    // Snapshot signals synchronously so Effect.gen is not a reactive scope.
    const address = mainAddress()
    const mode = networkMode()

    return Effect.gen(function* () {
      if (!address) {
        return yield* Effect.fail(
          new WalletConnectError({
            cause: new Error("Connect a wallet with Reown before authorizing"),
          }),
        )
      }

      const modal = yield* Effect.tryPromise({
        try: () => ensureEvmAppKit(),
        catch: cause => new WalletConnectError({ cause }),
      })
      const provider = modal ? readConnectedEip1193Provider(modal) : null
      if (!provider) {
        return yield* Effect.fail(
          new WalletConnectError({
            cause: new Error("Reown wallet provider is unavailable"),
          }),
        )
      }

      const agentModule = yield* Effect.tryPromise({
        try: () => import("@/services/hyperliquidAgent"),
        catch: cause => new WalletConnectError({ cause }),
      })

      const agent = agentModule.generateHyperliquidAgent()
      const pendingCredentials: WalletCredentials = {
        accountAddress: address,
        apiWalletAddress: agent.agentAddress,
        privateKey: agent.agentPrivateKey,
      }

      const encrypted = yield* Effect.tryPromise({
        try: () => encryptWalletPrivateKey(pendingCredentials.privateKey, pin),
        catch: cause => new WalletConnectError({ cause }),
      })

      const approveResult = yield* Effect.either(
        agentModule.approveHyperliquidAgent(
          provider,
          address,
          agent.agentAddress,
          mode,
        ),
      )

      if (Either.isLeft(approveResult)) {
        clearEncryptedSession()
        syncStoredSessionState()
        setCredentials(null)
        return yield* Effect.fail(
          new WalletConnectError({ cause: approveResult.left }),
        )
      }

      persistEncryptedSession(pendingCredentials, encrypted)
      syncStoredSessionState()
      setCredentials(pendingCredentials)
    })
  }

  /**
   * Reown-signed revoke on Hyperliquid, then drop the local agent session.
   * Main wallet address stays connected for read-only loads.
   */
  const revokeAgent = (): Effect.Effect<void, WalletConnectError> => {
    // Snapshot signals synchronously so Effect.gen is not a reactive scope.
    const address = mainAddress()
    const mode = networkMode()

    return Effect.gen(function* () {
      if (!address) {
        return yield* Effect.fail(
          new WalletConnectError({
            cause: new Error("Connect a wallet with Reown before revoking"),
          }),
        )
      }

      const modal = yield* Effect.tryPromise({
        try: () => ensureEvmAppKit(),
        catch: cause => new WalletConnectError({ cause }),
      })
      const provider = modal ? readConnectedEip1193Provider(modal) : null
      if (!provider) {
        return yield* Effect.fail(
          new WalletConnectError({
            cause: new Error("Reown wallet provider is unavailable"),
          }),
        )
      }

      const agentModule = yield* Effect.tryPromise({
        try: () => import("@/services/hyperliquidAgent"),
        catch: cause => new WalletConnectError({ cause }),
      })

      const revokeResult = yield* Effect.either(
        agentModule.revokeHyperliquidAgent(provider, address, mode),
      )

      if (Either.isLeft(revokeResult)) {
        return yield* Effect.fail(
          new WalletConnectError({ cause: revokeResult.left }),
        )
      }

      setCredentials(null)
      clearEncryptedSession()
      syncStoredSessionState()
    })
  }

  const unlock = (pin: string): Effect.Effect<void, WalletUnlockFailure> => {
    const session = getStoredEncryptedSession()
    if (!session) {
      return Effect.fail(new WalletSessionMissing())
    }

    return decryptWalletPrivateKey(
      session.encryptedPrivateKey,
      pin,
      session.salt,
      session.iv,
    ).pipe(
      Effect.tap(privateKey =>
        Effect.sync(() => {
          setMainAddressState(session.accountAddress)
          setCredentials(credentialsFromSession(session, privateKey))
        }),
      ),
      Effect.asVoid,
    )
  }

  const disconnect = (): Effect.Effect<void, WalletDisconnectFailed> =>
    Effect.gen(function* () {
      const modal = yield* Effect.tryPromise({
        try: () => ensureEvmAppKit(),
        catch: cause => new WalletDisconnectFailed({ cause }),
      })

      if (modal) {
        yield* Effect.tryPromise({
          try: () => modal.disconnect("eip155"),
          catch: cause => new WalletDisconnectFailed({ cause }),
        })
      }

      setCredentials(null)
      setMainAddressState(null)
      clearEncryptedSession()
      syncStoredSessionState()
    })

  const setNetworkMode = (mode: NetworkMode) => {
    setNetworkModeState(mode)
    localStorage.setItem(NETWORK_STORAGE_KEY, mode)
  }

  const handleStorageChange = (event: StorageEvent) => {
    if (event.key === WALLET_STORAGE_KEY) {
      setCredentials(null)
      const nextSession = getStoredEncryptedSession()
      syncStoredSessionState()
      if (nextSession) {
        setMainAddressState(nextSession.accountAddress)
      }
    }
    if (event.key === NETWORK_STORAGE_KEY) {
      setNetworkModeState(getStoredNetworkMode())
    }
  }

  onMount(() => {
    // Defer CCXT until after the first paint so dockview/UI can render without
    // competing with a ~500KB module download+eval on the same turn.
    const startClientLoad = () => {
      prefetchHyperliquidClientModule()
      void ensureHyperliquidClientModule().then(clientModule => {
        setHyperliquidClientClass(() => clientModule.HyperliquidClient)
      })
    }

    let idleCallbackId: number | undefined
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    if (typeof window.requestIdleCallback === "function") {
      idleCallbackId = window.requestIdleCallback(startClientLoad, {
        timeout: 2_000,
      })
    } else {
      timeoutId = setTimeout(startClientLoad, 0)
    }

    window.addEventListener("storage", handleStorageChange)

    onCleanup(() => {
      if (idleCallbackId !== undefined) {
        window.cancelIdleCallback(idleCallbackId)
      }
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
      }
      window.removeEventListener("storage", handleStorageChange)
    })
  })

  return (
    <WalletContext.Provider
      value={{
        mainAddress,
        credentials,
        networkMode,
        isConnected,
        isLocked,
        hasStoredSession,
        canTrade,
        client,
        connect,
        authorizeAgent,
        revokeAgent,
        unlock,
        disconnect,
        setNetworkMode,
        setMainAddress,
      }}
    >
      {props.children}
    </WalletContext.Provider>
  )
}
