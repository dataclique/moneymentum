import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"

import { WalletIncorrectPin } from "./wallet"
import {
  decryptWalletPrivateKey,
  encryptWalletPrivateKey,
  WALLET_PIN_LENGTH,
} from "./walletCredentialCrypto"

const failureError = async <ErrorType>(
  effect: Effect.Effect<unknown, ErrorType>,
): Promise<ErrorType> => {
  const exit = await Effect.runPromiseExit(effect)
  if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
    return exit.cause.error
  }
  throw new Error(`expected a tagged failure, got: ${JSON.stringify(exit)}`)
}

describe("walletCredentialCrypto", () => {
  it("round-trips a private key with the same pin", async () => {
    const privateKey = "0xabc123privatekey"
    const pin = "654321"

    const encrypted = await encryptWalletPrivateKey(privateKey, pin)
    const decrypted = await Effect.runPromise(
      decryptWalletPrivateKey(
        encrypted.encryptedPrivateKey,
        pin,
        encrypted.salt,
        encrypted.iv,
      ),
    )

    expect(decrypted).toBe(privateKey)
    expect(encrypted.encryptedPrivateKey).not.toContain(privateKey)
  })

  it("rejects pins that are not exactly six characters", async () => {
    const shortPin = "1".repeat(WALLET_PIN_LENGTH - 1)
    const longPin = "1".repeat(WALLET_PIN_LENGTH + 1)

    await expect(
      encryptWalletPrivateKey("0xsecret", shortPin),
    ).rejects.toMatchObject({
      name: "WalletCredentialCryptoError",
    })
    await expect(
      encryptWalletPrivateKey("0xsecret", longPin),
    ).rejects.toMatchObject({
      name: "WalletCredentialCryptoError",
    })
  })

  it("rejects decryption with the wrong pin", async () => {
    const encrypted = await encryptWalletPrivateKey("0xsecret", "123456")

    const error = await failureError(
      decryptWalletPrivateKey(
        encrypted.encryptedPrivateKey,
        "999999",
        encrypted.salt,
        encrypted.iv,
      ),
    )

    expect(error).toBeInstanceOf(WalletIncorrectPin)
    expect(error._tag).toBe("WalletIncorrectPin")
  })

  it("produces different ciphertext for the same key on each encryption", async () => {
    const first = await encryptWalletPrivateKey("0xsecret", "123456")
    const second = await encryptWalletPrivateKey("0xsecret", "123456")

    expect(first.encryptedPrivateKey).not.toBe(second.encryptedPrivateKey)
    expect(first.salt).not.toBe(second.salt)
    expect(first.iv).not.toBe(second.iv)
  })
})
