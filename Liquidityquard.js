const crypto = require('crypto');

const BYBIT_BASE_URL = 'https://bybit.com';

/**
 * Checks if a single symbol meets liquidity thresholds.
 */
function checkLiquidity(symbolInfo = {}, accountEquityUsd = 10000, targetPositionFrac = 0.01) {
  const volume24hUsd = Number(symbolInfo.volume24hUsd || 0);
  const spreadPct = Number(symbolInfo.spreadPct || 0);
  const topOfBookDepthUsd = Number(symbolInfo.topOfBookDepthUsd || 0);
  const targetUsd = Number(accountEquityUsd || 0) * Number(targetPositionFrac || 0.01);

  if (spreadPct > 0.12) {
    return { valid: false, reason: 'spread_too_high' };
  }

  if (volume24hUsd < targetUsd * 2) {
    return { valid: false, reason: 'insufficient_24h_volume' };
  }

  if (topOfBookDepthUsd < targetUsd) {
    return { valid: false, reason: 'insufficient_depth' };
  }

  return { valid: true, reason: 'liquid' };
}

/**
 * Fetches live total equity in USD from Bybit's Unified Trading Account.
 * Requires BYBIT_API_KEY and BYBIT_API_SECRET environment variables.
 */
async function getAccountEquity(accountType = 'UNIFIED') {
  const apiKey = process.env.BYBIT_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error('Missing BYBIT_API_KEY or BYBIT_API_SECRET environment variables.');
  }

  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  const queryString = `accountType=${accountType}`;

  // Bybit V5 signature payload: timestamp + apiKey + recvWindow + queryString
  const signPayload = timestamp + apiKey + recvWindow + queryString;
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(signPayload)
    .digest('hex');

  const url = `${BYBIT_BASE_URL}/v5/account/wallet-balance?${queryString}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-SIGN': signature,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': recvWindow,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP error fetching wallet balance: ${response.status}`);
  }

  const data = await response.json();
  if (data.retCode !== 0) {
    throw new Error(`Bybit API error (${data.retCode}): ${data.retMsg}`);
  }

  const accountList = data.result?.list || [];
  if (accountList.length === 0) {
    throw new Error(`No wallet data found for accountType: ${accountType}`);
  }

  return Number(accountList[0].totalEquity || 0);
}

/**
 * Automatically fetches live account equity and filters Bybit tickers for liquidity.
 * @param {string} category - 'linear', 'spot', or 'inverse'
 * @param {number} targetPositionFrac - Target position size as a fraction of live equity (default 1%)
 * @param {string} accountType - 'UNIFIED' (default) or 'CONTRACT'
 */
async function getDynamicLiquidSymbols(category = 'linear', targetPositionFrac = 0.01, accountType = 'UNIFIED') {
  // 1. Automatically fetch live equity
  const liveEquityUsd = await getAccountEquity(accountType);

  if (liveEquityUsd <= 0) {
    throw new Error('Account equity is $0 or invalid. Cannot calculate position sizing.');
  }

  // 2. Fetch all market tickers
  const url = `${BYBIT_BASE_URL}/v5/market/tickers?category=${category}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP error fetching tickers: ${response.status}`);
  }

  const data = await response.json();
  if (data.retCode !== 0) {
    throw new Error(`Bybit API error (${data.retCode}): ${data.retMsg}`);
  }

  const tickers = data.result?.list || [];
  const results = [];

  for (const ticker of tickers) {
    if (!ticker.symbol.endsWith('USDT')) continue;

    const bidPrice = Number(ticker.bid1Price || 0);
    const askPrice = Number(ticker.ask1Price || 0);
    const bidSize = Number(ticker.bid1Size || 0);
    const askSize = Number(ticker.ask1Size || 0);
    const volume24hUsd = Number(ticker.turnover24h || 0);

    if (bidPrice <= 0 || askPrice <= 0) continue;

    const spreadPct = ((askPrice - bidPrice) / askPrice) * 100;
    const topOfBookDepthUsd = Math.min(bidPrice * bidSize, askPrice * askSize);

    const symbolInfo = {
      symbol: ticker.symbol,
      volume24hUsd,
      spreadPct,
      topOfBookDepthUsd
    };

    // 3. Validate using live equity
    const status = checkLiquidity(symbolInfo, liveEquityUsd, targetPositionFrac);

    if (status.valid) {
      results.push({
        ...symbolInfo,
        targetPositionUsd: Number((liveEquityUsd * targetPositionFrac).toFixed(2)),
        ...status
      });
    }
  }

  return {
    accountEquityUsd: liveEquityUsd,
    targetPositionUsd: Number((liveEquityUsd * targetPositionFrac).toFixed(2)),
    liquidSymbols: results
  };
}

// Run directly from terminal
if (require.main === module) {
  getDynamicLiquidSymbols('linear', 0.01)
    .then(({ accountEquityUsd, targetPositionUsd, liquidSymbols }) => {
      console.log(`Live Account Equity: $${accountEquityUsd.toFixed(2)}`);
      console.log(`Dynamic Target Size (1%): $${targetPositionUsd.toFixed(2)}`);
      console.log(`Found ${liquidSymbols.length} liquid USDT pairs:`);
      console.table(liquidSymbols.slice(0, 10));
    })
    .catch((err) => console.error('Liquidity Guard Error:', err.message));
}

module.exports = {
  checkLiquidity,
  getAccountEquity,
  getDynamicLiquidSymbols
};
