import { describe, expect, it } from "vitest"

import {
  decryptWalletPrivateKey,
  encryptWalletPrivateKey,
  WALLET_PIN_LENGTH,
  WalletCredentialDecryptError,
} from "./walletCredentialCrypto"

describe("walletCredentialCrypto", () => {
  it("round-trips a private key with the same pin", async () => {
    const privateKey = "0xabc123privatekey"
    const pin = "654321"

    const encrypted = await encryptWalletPrivateKey(privateKey, pin)
    const decrypted = await decryptWalletPrivateKey(
      encrypted.encryptedPrivateKey,
      pin,
      encrypted.salt,
      encrypted.iv,
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

    await expect(
      decryptWalletPrivateKey(
        encrypted.encryptedPrivateKey,
        "999999",
        encrypted.salt,
        encrypted.iv,
      ),
    ).rejects.toBeInstanceOf(WalletCredentialDecryptError)
  })

  it("produces different ciphertext for the same key on each encryption", async () => {
    const first = await encryptWalletPrivateKey("0xsecret", "123456")
    const second = await encryptWalletPrivateKey("0xsecret", "123456")

    expect(first.encryptedPrivateKey).not.toBe(second.encryptedPrivateKey)
    expect(first.salt).not.toBe(second.salt)
    expect(first.iv).not.toBe(second.iv)
  })
})
