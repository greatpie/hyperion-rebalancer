import {
  FeeTierIndex,
  FeeTierStep,
  initHyperionSDK,
} from "@hyperionxyz/sdk";
import {
  Account,
  Ed25519PrivateKey,
  Network,
  Aptos,
} from "@aptos-labs/ts-sdk";

const MONITORED_OWNER =
  process.env.LP_OWNER_ADDRESS ??
  "0xeb4cf3c644cddf8d406aa25b28872456111bd5682da8d09648aaee63fe6a6ac3";
const TARGET_POOL_ID =
  process.env.POOL_ID ??
  "0x1609a6f6e914e60bf958d0e1ba24a471ee2bcadeca9e72659336a1f002be50db";

const APTOS_API_KEY = process.env.APTOS_API_KEY ?? "";
const PRIVATE_KEY_HEX = process.env.APTOS_PRIVATE_KEY;

if (!PRIVATE_KEY_HEX) {
  throw new Error(
    "Missing APTOS_PRIVATE_KEY in environment. Set the LP owner's private key to enable rebalancing."
  );
}

const SLIPPAGE_PERCENT = Number(process.env.SLIPPAGE_PERCENT ?? "0.1");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? "60000");
const TICK_HALF_WIDTH = Number(process.env.TICK_HALF_WIDTH ?? "10");
const SWAP_SAFE_MODE = process.env.SWAP_SAFE_MODE !== "false";

const sdk = initHyperionSDK({
  network: Network.MAINNET,
  APTOS_API_KEY,
});
const aptos: Aptos = sdk.AptosClient;

const signer = Account.fromPrivateKey({
  privateKey: new Ed25519PrivateKey(PRIVATE_KEY_HEX),
});

const OWNER_ADDRESS = signer.accountAddress.toString();
if (OWNER_ADDRESS.toLowerCase() !== MONITORED_OWNER.toLowerCase()) {
  console.warn(
    `Warning: signer address ${OWNER_ADDRESS} does not match monitored address ${MONITORED_OWNER}`
  );
}

type TokenInfo = {
  assetType: string;
  faType?: string | null;
  coinType?: string | null;
  decimals: number;
  symbol: string;
};

type IndexedPool = {
  currentTick: number;
  feeRate: number | string;
  feeTier: number;
  poolId: string;
  token1: string;
  token2: string;
  token1Info: TokenInfo;
  token2Info: TokenInfo;
};

type IndexedPosition = {
  objectId: string;
  poolId: string;
  currentAmount: number | string;
  position: {
    tickLower: number;
    tickUpper: number;
  };
  pool: IndexedPool[];
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bigIntFrom(value: number | string | bigint): bigint {
  return BigInt(value);
}

function normalizeAddress(info: TokenInfo | undefined, fallback: string) {
  if (!info) return fallback;
  if (info.coinType && info.coinType.length > 0) return info.coinType;
  if (info.faType && info.faType.length > 0) return info.faType;
  return info.assetType;
}

function computeTickRange(
  currentTick: number,
  feeTierIndex: number,
  halfWidth: number
) {
  const spacing = FeeTierStep[feeTierIndex] ?? 1;
  const rounded = Math.floor(currentTick / spacing) * spacing;
  const lower = rounded - halfWidth * spacing;
  const upper = rounded + halfWidth * spacing;
  if (lower === upper) {
    return { lower: rounded - spacing, upper: rounded + spacing };
  }
  return { lower, upper };
}

async function submitTransaction(
  payload: any,
  description: string
): Promise<string> {
  const transaction = await aptos.transaction.build.simple({
    sender: OWNER_ADDRESS,
    data: payload,
  });
  const committed = await aptos.signAndSubmitTransaction({
    signer,
    transaction,
  });
  await aptos.waitForTransaction({ transactionHash: committed.hash });
  console.info(`${description} tx hash: ${committed.hash}`);
  return committed.hash;
}

async function fetchPositions(): Promise<IndexedPosition[]> {
  const result = await sdk.Position.fetchAllPositionsByAddress({
    address: MONITORED_OWNER,
  });
  return (result as IndexedPosition[]).filter(
    (position) => position.poolId.toLowerCase() === TARGET_POOL_ID.toLowerCase()
  );
}

function isOutOfRange(position: IndexedPosition, pool: IndexedPool) {
  const currentTick = Number(pool.currentTick);
  return (
    currentTick <= Number(position.position.tickLower) ||
    currentTick >= Number(position.position.tickUpper)
  );
}

async function planLiquidity(
  availableA: bigint,
  availableB: bigint,
  params: {
    currencyA: string;
    currencyB: string;
    feeTierIndex: number;
    tickLower: number;
    tickUpper: number;
    currentTick: number;
  },
  allowSwap: boolean
) {
  const { currencyA, currencyB, feeTierIndex, tickLower, tickUpper, currentTick } =
    params;

  let workingA = availableA;
  let workingB = availableB;
  let swapPlan:
    | {
        amountIn: bigint;
        expectedOut: bigint;
        path: string[];
      }
    | undefined;

  const estimateFromA = await sdk.Pool.estCurrencyBAmountFromA({
    currencyA,
    currencyB,
    feeTierIndex,
    tickLower,
    tickUpper,
    currentPriceTick: currentTick,
    currencyAAmount: workingA.toString(),
  });

  let requiredB = bigIntFrom(estimateFromA[1]);

  if (allowSwap && requiredB > workingB) {
    const shortfall = requiredB - workingB;
    const quote = await sdk.Swap.estFromAmount({
      amount: shortfall.toString(),
      from: currencyA,
      to: currencyB,
      safeMode: SWAP_SAFE_MODE,
    });
    const amountIn = bigIntFrom(quote.amountIn);
    const amountOut = bigIntFrom(quote.amountOut);
    if (amountIn >= workingA) {
      throw new Error("Insufficient currencyA balance to cover swap for rebalancing");
    }
    swapPlan = {
      amountIn,
      expectedOut: amountOut,
      path: quote.path,
    };
    workingA -= amountIn;
    workingB += amountOut;
  }

  const postSwapEstimate = await sdk.Pool.estCurrencyBAmountFromA({
    currencyA,
    currencyB,
    feeTierIndex,
    tickLower,
    tickUpper,
    currentPriceTick: currentTick,
    currencyAAmount: workingA.toString(),
  });

  let depositA = workingA;
  let depositB = bigIntFrom(postSwapEstimate[1]);

  if (depositB > workingB) {
    const adjust = await sdk.Pool.estCurrencyAAmountFromB({
      currencyA,
      currencyB,
      feeTierIndex,
      tickLower,
      tickUpper,
      currentPriceTick: currentTick,
      currencyBAmount: workingB.toString(),
    });
    depositA = bigIntFrom(adjust[1]);
    depositB = workingB;
  }

  return {
    swapPlan,
    depositA,
    depositB,
  };
}

async function rebalance(position: IndexedPosition) {
  const pool = position.pool[0];
  if (!pool) {
    console.warn("No pool data for position", position.objectId);
    return;
  }

  const feeTierIndex = Number(pool.feeTier) as FeeTierIndex;
  const currentTick = Number(pool.currentTick);
  const { lower: targetLower, upper: targetUpper } = computeTickRange(
    currentTick,
    feeTierIndex,
    TICK_HALF_WIDTH
  );

  const currencyA = normalizeAddress(pool.token1Info, pool.token1);
  const currencyB = normalizeAddress(pool.token2Info, pool.token2);

  const [rawA, rawB] = await sdk.Position.fetchTokensAmountByPositionId({
    positionId: position.objectId,
  });

  const availableA = bigIntFrom(rawA);
  const availableB = bigIntFrom(rawB);
  const deltaLiquidity = bigIntFrom(position.currentAmount);

  if (deltaLiquidity > 0n && (availableA > 0n || availableB > 0n)) {
    console.info(
      `Removing liquidity from position ${position.objectId} (liquidity=${deltaLiquidity})`
    );
    const removePayload = await sdk.Position.removeLiquidityTransactionPayload({
      positionId: position.objectId,
      currencyA,
      currencyB,
      currencyAAmount: availableA.toString(),
      currencyBAmount: availableB.toString(),
      deltaLiquidity: deltaLiquidity.toString(),
      slippage: SLIPPAGE_PERCENT,
      recipient: OWNER_ADDRESS,
    });
    await submitTransaction(removePayload, "remove-liquidity");
  }

  const baseParams = {
    currencyA,
    currencyB,
    feeTierIndex,
    tickLower: targetLower,
    tickUpper: targetUpper,
    currentTick,
  };

  const initialPlan = await planLiquidity(availableA, availableB, baseParams, true);
  let plan = initialPlan;
  let postSwapA = availableA;
  let postSwapB = availableB;

  if (initialPlan.swapPlan) {
    const { amountIn, expectedOut, path } = initialPlan.swapPlan;
    console.info(
      `Swapping ${amountIn} of ${pool.token1Info.symbol} for ${pool.token2Info.symbol}`
    );
    const swapPayload = await sdk.Swap.swapTransactionPayload({
      currencyA,
      currencyB,
      currencyAAmount: amountIn.toString(),
      currencyBAmount: expectedOut.toString(),
      slippage: SLIPPAGE_PERCENT,
      poolRoute: path,
      recipient: OWNER_ADDRESS,
    });
    await submitTransaction(swapPayload, "swap");
    postSwapA = availableA - amountIn;
    postSwapB = availableB + expectedOut;
    plan = await planLiquidity(postSwapA, postSwapB, baseParams, false);
  }

  if (plan.depositA === 0n || plan.depositB === 0n) {
    console.warn(
      `Skipping add liquidity due to empty amounts (A=${plan.depositA}, B=${plan.depositB})`
    );
    return;
  }

  console.info(
    `Adding liquidity with ${plan.depositA} ${pool.token1Info.symbol} and ${plan.depositB} ${pool.token2Info.symbol}`
  );

  const addPayload = await sdk.Pool.createPoolTransactionPayload({
    currencyA,
    currencyB,
    currencyAAmount: plan.depositA.toString(),
    currencyBAmount: plan.depositB.toString(),
    feeTierIndex,
    currentPriceTick: currentTick,
    tickLower: targetLower,
    tickUpper: targetUpper,
    slippage: SLIPPAGE_PERCENT,
  });
  await submitTransaction(addPayload, "add-liquidity");
}

async function main() {
  console.info("Starting Hyperion LP rebalancer...");
  while (true) {
    try {
      const positions = await fetchPositions();
      for (const position of positions) {
        const pool = position.pool[0];
        if (!pool) continue;
        const currentAmount = bigIntFrom(position.currentAmount);
        if (currentAmount === 0n) continue;
        if (isOutOfRange(position, pool)) {
          console.info(
            `Position ${position.objectId} out of range. Rebalancing...`
          );
          await rebalance(position);
        }
      }
    } catch (error) {
      console.error("Rebalance cycle failed", error);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error("Fatal error", err);
  process.exit(1);
});
