# hyperion-rebalancer

Hyperion LP rebalancer that monitors a USD1/USDC position on Aptos and automatically removes liquidity, swaps the necessary tokens, and re-deploys capital whenever the position leaves its active tick range.

## Setup

Install dependencies with Bun:

```bash
bun install
```

Set the required environment variables before running the rebalancer:

| Variable | Description |
| --- | --- |
| `APTOS_PRIVATE_KEY` | Hex-encoded Ed25519 private key for the LP owner account. |
| `APTOS_API_KEY` | (Optional) Aptos public API key used by the Hyperion SDK. |
| `LP_OWNER_ADDRESS` | (Optional) Address to monitor. Defaults to the provided example account. |
| `POOL_ID` | (Optional) Hyperion pool ID. Defaults to the USD1/USDC pool. |
| `SLIPPAGE_PERCENT` | (Optional) Slippage percentage used for swaps and liquidity operations. Defaults to `0.1`. |
| `POLL_INTERVAL_MS` | (Optional) Polling interval in milliseconds. Defaults to `60000`. |
| `TICK_HALF_WIDTH` | (Optional) Half-width (in ticks) around the current price to target when opening a new position. Defaults to `10`. |
| `SWAP_SAFE_MODE` | (Optional) Set to `false` to disable the SDK's safe-mode route filtering. |

## Running

Run the rebalancer with Bun:

```bash
bun run index.ts
```

The script runs indefinitely, polling the target position and submitting Aptos transactions when rebalancing is required.
