# Reown AppKit + Solana USDC (демо)

Маршрут: **`/appkit-test`**. Страница — тонкая оболочка; логика в
**`src/reown/solanaUsdc.ts`**.

---

## Что делает демо

1. Подключение Solana-кошелька через **Reown AppKit**
   (`getOrCreateSolanaAppKit`).
2. Переключение **mainnet / devnet** (`reownNetworkForSolanaCluster` +
   `modal.switchNetwork`).
3. Поля **адрес получателя** и **сумма USDC**, кнопка **Send USDC**
   (`sendUsdcTransfer`).

Подпись транзакции в кошельке: **`provider.sendTransaction`** (тип `Provider` в
`@reown/appkit-utils/solana`).

---

## Модуль `src/reown/solanaUsdc.ts`

| Экспорт                                                                           | Назначение                                                                                 |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `SolanaCluster`                                                                   | `"mainnet" \| "devnet"`                                                                    |
| `USDC_MAINNET_MINT`                                                               | Mint USDC на mainnet (Circle).                                                             |
| `USDC_DEVNET_MINT`                                                                | Mint тестового USDC на devnet (Circle).                                                    |
| `readReownProjectId()`                                                            | `VITE_REOWN_PROJECT_ID` для AppKit и RPC.                                                  |
| `reownNetworkForSolanaCluster(cluster)`                                           | Сеть для `modal.switchNetwork`.                                                            |
| `getOrCreateSolanaAppKit()`                                                       | Синглтон `AppKit` для демо.                                                                |
| `usdcMintAddressForCluster(cluster)`                                              | `USDC_MAINNET_MINT` или `USDC_DEVNET_MINT`.                                                |
| `buildSolanaRpcConnection(modal, projectId, cluster)`                             | `Connection` для того же cluster, что и mint; проверка совпадения с активной сетью AppKit. |
| `readSolanaAddressFromAccountState` / `readSolanaWalletConnectedFromAccountState` | Разбор `subscribeAccount`.                                                                 |
| `sendUsdcTransfer(...)`                                                           | SPL transfer, idempotent ATA получателя, decimals с mint.                                  |
| `solscanTransactionUrl(cluster, signature)`                                       | Solscan.                                                                                   |

---

## Окружение

Нужен только **`VITE_REOWN_PROJECT_ID`**. Опционально
**`VITE_SOLANA_TRANSFER_RECIPIENT`** — начальное значение поля получателя на
странице демо.

---

## Типичные проблемы

- **504 Outdated Optimize Dep (Vite)** — удалить `node_modules/.vite`,
  перезапустить dev, жёстко обновить вкладку.
- **Дублирование `projectId` в RPC** — обработано в `buildSolanaRpcConnection`.
