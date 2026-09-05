import { PROPERTY_CATALOG, GROUP_SIZES } from "./properties.js";
import { RULEBOOK_VERSION, RULES } from "./rules.js";

const BANK = "BANK";
const POT = "FREE_PARKING";

export const SYSTEM_ENTITIES = { BANK, POT };
export const PLAYER_COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#eab308"];
export const GAME_DEFAULTS = Object.freeze({
  legalFee: 25,
  mergerFee: 200,
  dealSettlementLagRounds: 2,
  stockDividendRate: 0.20,
  stockInitialPrice: 10,
  stockInitialShares: 100,
  stockAuthorizedShares: 150,
  taxIntervalRounds: 5,
  totalBankCash: 20580,
  bankReserveFloor: 1000,
  bankLoanMaximum: 500,
  bankLoanMinimum: 50,
  bankLoanTermRounds: 3,
  bankRateAtFullLiquidityPercent: 8,
  bankRateSensitivityPercent: 18,
  bankRateMinimumPercent: 5,
  bankRateMaximumPercent: 30,
  bankRateRandomSpreadMaximumPercent: 3
});

const clone = value => globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
const uid = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const isoNow = () => new Date().toISOString();
const round2 = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
export const MONEY_UNIT = 1;
export const roundMoney = value => Math.round(Number(value || 0) / MONEY_UNIT) * MONEY_UNIT;
const roundRate = value => Math.round(Number(value || 0));
const UNDO_DEPTH = 30;

function makeTicker(name, index) {
  const letters = String(name || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
  return `${letters || "CO"}${index + 1}`.slice(0, 4);
}

function allocateMoney(total, weights) {
  const amount = Math.max(0, roundMoney(total));
  const clean = (weights || []).map((item, index) => ({
    ...item,
    index,
    weight: Math.max(0, Number(item.weight || 0))
  })).filter(item => item.weight > 0);
  const weightTotal = clean.reduce((sum, item) => sum + item.weight, 0);
  if (!amount || !weightTotal || !clean.length) return clean.map(item => ({ ...item, amount: 0 }));
  const allocated = clean.map(item => {
    const exact = amount * item.weight / weightTotal;
    const floor = Math.floor(exact);
    return { ...item, amount: floor, remainder: exact - floor };
  });
  let remaining = amount - allocated.reduce((sum, item) => sum + item.amount, 0);
  allocated.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < remaining; i += 1) allocated[i % allocated.length].amount += MONEY_UNIT;
  return allocated.sort((a, b) => a.index - b.index).map(({ remainder, index, weight, ...item }) => item);
}

export function createGame(playerNames, options = {}) {
  const names = playerNames.map(name => String(name || "").trim()).filter(Boolean);
  if (names.length !== 4) throw new Error("Boardroom Chaos is designed for exactly four players.");
  if (new Set(names.map(n => n.toLowerCase())).size !== names.length) throw new Error("Player names must be unique.");

  const players = names.map((name, index) => ({
    id: `P${index + 1}`,
    name,
    color: PLAYER_COLORS[index],
    cash: roundMoney(options.startingCash ?? 1500),
    jailFreeCards: 0,
    inJail: false,
    bankrupt: false,
    mergedInto: null,
    antitrustHalfRentUntilRound: 0,
    constructionFreezeUntilRound: 0,
    companyName: `${name} Holdings`,
    ticker: makeTicker(name, index)
  }));
  const startingCash = roundMoney(options.startingCash ?? 1500);
  const bank = defaultBankState(players, {
    startingCash,
    bankStartingCash: options.bankStartingCash,
    reserveFloor: options.bankReserveFloor,
    initialRatePercent: options.bankInitialRatePercent
  });

  const game = {
    schemaVersion: 4,
    rulebookVersion: RULEBOOK_VERSION,
    id: uid("game"),
    name: options.name || "Boardroom Chaos",
    createdAt: isoNow(),
    updatedAt: isoNow(),
    round: 1,
    activePlayerIndex: 0,
    freeParkingPot: 0,
    bankSupply: { houses: 32, hotels: 12 },
    bank,
    settings: {
      freeParkingJackpot: options.freeParkingJackpot ?? true,
      judgeMode: options.judgeMode || "advisory",
      localAutosave: true,
      voiceReadback: options.voiceReadback ?? true,
      voicePreferLocal: options.voicePreferLocal ?? true,
      voiceLanguage: options.voiceLanguage || "en-US",
      legalFee: roundMoney(options.legalFee ?? GAME_DEFAULTS.legalFee),
      mergerFee: roundMoney(options.mergerFee ?? GAME_DEFAULTS.mergerFee),
      dealSettlementLagRounds: Number(options.dealSettlementLagRounds ?? GAME_DEFAULTS.dealSettlementLagRounds),
      stockDividendRate: Number(options.stockDividendRate ?? GAME_DEFAULTS.stockDividendRate),
      taxIntervalRounds: Number(options.taxIntervalRounds ?? GAME_DEFAULTS.taxIntervalRounds),
      bankLoanMaximum: Number(options.bankLoanMaximum ?? GAME_DEFAULTS.bankLoanMaximum),
      bankLoanMinimum: Number(options.bankLoanMinimum ?? GAME_DEFAULTS.bankLoanMinimum),
      bankLoanTermRounds: Number(options.bankLoanTermRounds ?? GAME_DEFAULTS.bankLoanTermRounds)
    },
    players,
    market: defaultMarketForPlayers(players),
    properties: PROPERTY_CATALOG.map(property => ({
      ...clone(property),
      ownerShares: [],
      mortgaged: false,
      buildings: 0
    })),
    deals: [],
    contracts: [],
    loans: [],
    organizations: [],
    policies: [],
    mergers: [],
    antitrustReviews: [],
    taxBills: [],
    disputes: [],
    judgements: [],
    ledger: [{
      id: uid("evt"),
      at: isoNow(),
      round: 1,
      type: "game_created",
      description: `Four-company game created for ${names.join(", ")}.`,
      actorIds: players.map(p => p.id),
      metadata: {
        startingCash,
        bankInitialCash: bank.initialCash,
        bankInitialRatePercent: bank.lending.currentRatePercent,
        legalFee: roundMoney(options.legalFee ?? GAME_DEFAULTS.legalFee),
        mergerFee: roundMoney(options.mergerFee ?? GAME_DEFAULTS.mergerFee),
        settlementLagRounds: Number(options.dealSettlementLagRounds ?? GAME_DEFAULTS.dealSettlementLagRounds)
      }
    }],
    undoStack: []
  };
  validateState(game);
  return game;
}

function snapshotForUndo(state) {
  // Snapshots are never mutated after they are taken, so the undo stack can share them
  // by reference rather than deep-cloning every earlier snapshot on each commit.
  return clone({ ...state, undoStack: [] });
}

export function commit(state, type, description, mutator, metadata = {}, actorIds = []) {
  const { undoStack = [], ...live } = state;
  const next = clone(live);
  next.undoStack = [...undoStack, snapshotForUndo(live)].slice(-UNDO_DEPTH);
  mutator(next);
  next.updatedAt = isoNow();
  next.ledger.unshift({
    id: uid("evt"),
    at: isoNow(),
    round: next.round,
    type,
    description,
    actorIds,
    metadata: clone(metadata)
  });
  validateState(next);
  return next;
}

export function undoLast(state, reason = "Clerical correction") {
  if (!state.undoStack?.length) throw new Error("Nothing is available to undo.");
  const stack = [...state.undoStack];
  const restored = clone(stack.pop());
  const undone = state.ledger?.[0];
  restored.undoStack = stack;
  restored.updatedAt = isoNow();
  restored.ledger.unshift({
    id: uid("evt"),
    at: isoNow(),
    round: restored.round,
    type: "undo",
    description: `${reason}: reversed “${undone?.description || "last action"}”.`,
    actorIds: [],
    metadata: { undoneEventId: undone?.id || null }
  });
  validateState(restored);
  return restored;
}

export function getPlayer(state, playerId) {
  const player = state.players.find(p => p.id === playerId);
  if (!player) throw new Error("Player not found.");
  return player;
}

export function entityName(state, entityId) {
  if (entityId === BANK) return "Bank";
  if (entityId === POT) return "Free Parking pot";
  return state.players.find(p => p.id === entityId)?.name
    || state.organizations.find(o => o.id === entityId)?.name
    || "Unknown entity";
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number(value)));
}

function bankRateComponents(state, spreadOverride = null) {
  const bank = state.bank;
  const initialCash = Math.max(1, Number(bank?.initialCash || GAME_DEFAULTS.totalBankCash));
  const cash = Math.max(0, Number(bank?.cash || 0));
  const liquidityRatio = cash / initialCash;
  const emergencyCredit = Math.max(0, Number(bank?.emergencyCredit || 0));
  const baseRatePercent = emergencyCredit > 0 ? GAME_DEFAULTS.bankRateMaximumPercent : clamp(
    GAME_DEFAULTS.bankRateAtFullLiquidityPercent + (1 - liquidityRatio) * GAME_DEFAULTS.bankRateSensitivityPercent,
    GAME_DEFAULTS.bankRateMinimumPercent,
    GAME_DEFAULTS.bankRateMaximumPercent
  );
  const randomSpreadPercent = clamp(
    spreadOverride ?? bank?.lending?.randomSpreadPercent ?? 0,
    -GAME_DEFAULTS.bankRateRandomSpreadMaximumPercent,
    GAME_DEFAULTS.bankRateRandomSpreadMaximumPercent
  );
  return {
    cash: roundMoney(cash),
    emergencyCredit: roundMoney(emergencyCredit),
    liquidityRatio: round2(liquidityRatio),
    baseRatePercent: roundRate(baseRatePercent),
    randomSpreadPercent: roundRate(randomSpreadPercent),
    ratePercent: roundRate(clamp(baseRatePercent + randomSpreadPercent, GAME_DEFAULTS.bankRateMinimumPercent, GAME_DEFAULTS.bankRateMaximumPercent))
  };
}

function refreshBankLendingRate(state, spreadOverride = null) {
  if (!state.bank) return;
  state.bank.lending ||= {};
  const components = bankRateComponents(state, spreadOverride);
  state.bank.lending.currentRatePercent = components.ratePercent;
  state.bank.lending.baseRatePercent = components.baseRatePercent;
  state.bank.lending.randomSpreadPercent = components.randomSpreadPercent;
  return components;
}

export function getBankLendingQuote(state) {
  const components = bankRateComponents(state);
  const reserveFloor = Number(state.bank?.reserveFloor ?? GAME_DEFAULTS.bankReserveFloor);
  const availableLiquidity = components.emergencyCredit > 0 ? 0 : roundMoney(Math.max(0, components.cash - reserveFloor));
  const activeLoans = (state.loans || []).filter(loan => loan.lenderId === BANK && ["active", "delinquent"].includes(loan.status));
  return {
    ...components,
    reserveFloor,
    availableLiquidity,
    maximumSingleLoan: roundMoney(Math.min(Number(state.settings?.bankLoanMaximum ?? GAME_DEFAULTS.bankLoanMaximum), availableLiquidity)),
    minimumLoan: Number(state.settings?.bankLoanMinimum ?? GAME_DEFAULTS.bankLoanMinimum),
    termRounds: Number(state.settings?.bankLoanTermRounds ?? GAME_DEFAULTS.bankLoanTermRounds),
    activePrincipal: roundMoney(activeLoans.reduce((sum, loan) => sum + Number(loan.principal || 0), 0)),
    activeBalance: roundMoney(activeLoans.reduce((sum, loan) => sum + Number(loan.balance || 0), 0))
  };
}

function adjustCash(state, entityId, delta) {
  if (entityId === BANK) {
    state.bank ||= { cash: 0, initialCash: GAME_DEFAULTS.totalBankCash, reserveFloor: GAME_DEFAULTS.bankReserveFloor, emergencyCredit: 0, lending: {} };
    const change = roundMoney(delta);
    state.bank.emergencyCredit = roundMoney(state.bank.emergencyCredit || 0);
    if (change >= 0) {
      const creditPayment = Math.min(change, state.bank.emergencyCredit);
      state.bank.emergencyCredit = roundMoney(state.bank.emergencyCredit - creditPayment);
      state.bank.cash = roundMoney(Number(state.bank.cash || 0) + change - creditPayment);
    } else {
      const payment = Math.abs(change);
      const fromCash = Math.min(payment, Number(state.bank.cash || 0));
      state.bank.cash = roundMoney(Number(state.bank.cash || 0) - fromCash);
      const shortfall = roundMoney(payment - fromCash);
      if (shortfall > 0) state.bank.emergencyCredit = roundMoney(state.bank.emergencyCredit + shortfall);
    }
    refreshBankLendingRate(state);
    return;
  }
  if (entityId === POT) {
    state.freeParkingPot = roundMoney(state.freeParkingPot + delta);
    if (state.freeParkingPot < 0) throw new Error("Free Parking pot cannot go below zero.");
    return;
  }
  const player = getPlayer(state, entityId);
  const cashPlayer = player.mergedInto ? getPlayer(state, player.mergedInto) : player;
  const result = roundMoney(cashPlayer.cash + delta);
  if (result < 0) throw new Error(`${cashPlayer.name} does not have enough cash.`);
  cashPlayer.cash = result;
}

function feeDestination(state) {
  return state.settings?.freeParkingJackpot === false ? BANK : POT;
}

function chargeFee(next, payerId, amount, label) {
  const value = roundMoney(amount);
  if (value <= 0) return;
  adjustCash(next, payerId, -value);
  adjustCash(next, feeDestination(next), value);
  return { payerId, amount: value, label, destination: feeDestination(next) };
}

export function getStock(state, companyId) {
  const stock = state.market?.stocks?.find(item => item.companyId === companyId || item.id === companyId);
  if (!stock) throw new Error("Company stock not found.");
  return stock;
}

function stockHolding(stock, entityId) {
  return Number(stock.holdings.find(item => item.entityId === entityId)?.shares || 0);
}

function normalizeStockHoldings(holdings) {
  return holdings
    .filter(item => Number(item.shares) > 0.0001)
    .map(item => ({ entityId: item.entityId, shares: round2(item.shares) }))
    .sort((a, b) => a.entityId.localeCompare(b.entityId));
}

export function stockOwnershipPercent(state, companyId, entityId) {
  const stock = getStock(state, companyId);
  return stock.outstandingShares ? round2(stockHolding(stock, entityId) / stock.outstandingShares * 100) : 0;
}

export function stockMarketValue(state, companyId, shares = null) {
  const stock = getStock(state, companyId);
  return roundMoney(stock.price * Number(shares ?? stock.outstandingShares));
}

function transferStockShares(next, companyId, fromId, toId, shares, issuance = false) {
  const stock = getStock(next, companyId);
  if (stock.status !== "active") throw new Error(`${stock.ticker} is no longer actively traded.`);
  const quantity = round2(Number(shares));
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Share quantity must be positive.");
  if (issuance) {
    if (fromId !== companyId) throw new Error("Only the listed company may issue new shares.");
    if (stock.outstandingShares + quantity > stock.authorizedShares + 0.001) throw new Error(`${stock.ticker} lacks enough authorized shares for this offering.`);
    stock.outstandingShares = round2(stock.outstandingShares + quantity);
  } else {
    const source = stock.holdings.find(item => item.entityId === fromId);
    if (!source || source.shares + 0.001 < quantity) throw new Error(`${entityName(next, fromId)} does not own ${quantity} shares of ${stock.ticker}.`);
    source.shares = round2(source.shares - quantity);
  }
  const target = stock.holdings.find(item => item.entityId === toId);
  if (target) target.shares = round2(target.shares + quantity);
  else stock.holdings.push({ entityId: toId, shares: quantity });
  stock.holdings = normalizeStockHoldings(stock.holdings);
}

function distributeCompanyRevenue(next, companyId, amount) {
  const gross = roundMoney(amount);
  if (gross <= 0) return [];
  const stock = next.market?.stocks?.find(item => item.companyId === companyId && item.status === "active");
  if (!stock || !stock.outstandingShares) {
    adjustCash(next, companyId, gross);
    return [{ entityId: companyId, amount: gross, kind: "company_revenue" }];
  }
  const dividendPool = roundMoney(gross * Number(next.settings.stockDividendRate ?? GAME_DEFAULTS.stockDividendRate));
  const retained = gross - dividendPool;
  const distributions = [];
  adjustCash(next, companyId, retained);
  distributions.push({ entityId: companyId, amount: retained, kind: "retained_revenue" });
  for (const allocation of allocateMoney(dividendPool, stock.holdings.map(holding => ({ entityId: holding.entityId, weight: holding.shares })))) {
    if (allocation.amount > 0) {
      adjustCash(next, allocation.entityId, allocation.amount);
      distributions.push({ entityId: allocation.entityId, amount: allocation.amount, kind: "shareholder_dividend", companyId });
    }
  }
  return distributions;
}

function randomStockMove(price, rng) {
  const marketDrift = (rng() - 0.5) * 0.06;
  const companyNoise = (rng() - 0.5) * 0.14;
  const shock = rng() < 0.08 ? (rng() - 0.5) * 0.30 : 0;
  const meanReversion = Math.max(-0.025, Math.min(0.025, ((GAME_DEFAULTS.stockInitialPrice - price) / Math.max(price, 1)) * 0.03));
  return Math.max(-0.20, Math.min(0.20, marketDrift + companyNoise + shock + meanReversion));
}

export function updateStockMarket(state, rng = Math.random) {
  return commit(state, "market_update", `Stock market prices moved for round ${state.round}.`, next => {
    for (const stock of next.market.stocks) {
      if (stock.status !== "active") continue;
      const previous = stock.price;
      const change = randomStockMove(previous, rng);
      stock.previousPrice = previous;
      stock.price = roundMoney(Math.max(1, Math.min(100, previous * (1 + change))));
      stock.lastChangePercent = round2((stock.price / previous - 1) * 100);
      stock.history.push({ round: next.round, price: stock.price, changePercent: stock.lastChangePercent });
      stock.history = stock.history.slice(-40);
    }
    next.market.lastUpdatedRound = next.round;
  }, { round: state.round });
}

export function updateBankLendingMarket(state, rng = Math.random) {
  const previousSpread = Number(state.bank?.lending?.randomSpreadPercent || 0);
  const randomImpulse = (Number(rng()) - 0.5) * 5;
  const nextSpread = roundRate(clamp(
    previousSpread * 0.45 + randomImpulse,
    -GAME_DEFAULTS.bankRateRandomSpreadMaximumPercent,
    GAME_DEFAULTS.bankRateRandomSpreadMaximumPercent
  ));
  return commit(state, "bank_rate_update", `The bank lending rate reset for round ${state.round}.`, next => {
    const quote = refreshBankLendingRate(next, nextSpread);
    next.bank.lending.lastUpdatedRound = next.round;
    next.bank.lending.history ||= [];
    next.bank.lending.history.push({ round: next.round, ...quote });
    next.bank.lending.history = next.bank.lending.history.slice(-40);
  }, { round: state.round, previousSpread: roundRate(previousSpread), randomSpreadPercent: roundRate(nextSpread) });
}

function activeBankLoansFor(state, borrowerId) {
  return (state.loans || []).filter(loan => loan.lenderId === BANK && loan.borrowerId === borrowerId && ["active", "delinquent"].includes(loan.status));
}

export function takeBankLoan(state, borrowerId, principal) {
  const borrower = getPlayer(state, borrowerId);
  if (borrower.bankrupt || borrower.mergedInto) throw new Error("Only an active independent company may borrow from the bank.");
  if (activeBankLoansFor(state, borrowerId).length) throw new Error(`${borrower.name} already has an unpaid bank loan.`);
  const amount = roundMoney(principal);
  const quote = getBankLendingQuote(state);
  if (!Number.isFinite(amount) || amount < quote.minimumLoan) throw new Error(`Bank loans must be at least $${quote.minimumLoan}.`);
  if (amount > quote.maximumSingleLoan + 0.001) throw new Error(`The bank can currently lend at most $${quote.maximumSingleLoan} to one company.`);
  const interestAmount = roundMoney(amount * quote.ratePercent / 100);
  const balance = roundMoney(amount + interestAmount);
  const loan = {
    id: uid("loan"),
    lenderId: BANK,
    borrowerId,
    principal: amount,
    ratePercent: quote.ratePercent,
    interestAmount,
    balance,
    createdRound: state.round,
    dueRound: state.round + quote.termRounds,
    status: "active",
    createdAt: isoNow(),
    delinquentAt: null,
    repaidAt: null
  };
  return commit(state, "bank_loan_issued", `${borrower.name} borrowed $${amount} from the bank at a locked ${quote.ratePercent}% rate; $${balance} is due in round ${loan.dueRound}.`, next => {
    adjustCash(next, BANK, -amount);
    adjustCash(next, borrowerId, amount);
    next.loans.unshift(loan);
  }, { loanId: loan.id, borrowerId, principal: amount, ratePercent: quote.ratePercent, interestAmount, balance, dueRound: loan.dueRound }, [borrowerId]);
}

export function repayBankLoan(state, loanId) {
  const loan = state.loans.find(item => item.id === loanId);
  if (!loan || loan.lenderId !== BANK || !["active", "delinquent"].includes(loan.status)) throw new Error("No unpaid bank loan was found.");
  const borrower = getPlayer(state, loan.borrowerId);
  if (borrower.cash + 0.001 < loan.balance) throw new Error(`${borrower.name} needs $${loan.balance} to repay this loan.`);
  return commit(state, "bank_loan_repaid", `${borrower.name} repaid the bank $${loan.balance} in full.`, next => {
    adjustCash(next, loan.borrowerId, -loan.balance);
    adjustCash(next, BANK, loan.balance);
    const target = next.loans.find(item => item.id === loanId);
    target.status = "repaid";
    target.repaidAt = isoNow();
  }, { loanId, borrowerId: loan.borrowerId, amount: loan.balance, principal: loan.principal, interestAmount: loan.interestAmount }, [loan.borrowerId]);
}

function markDelinquentBankLoans(state) {
  const overdue = (state.loans || []).filter(loan => loan.lenderId === BANK && loan.status === "active" && state.round > Number(loan.dueRound));
  if (!overdue.length) return state;
  return commit(state, "bank_loans_delinquent", `${overdue.length} bank loan${overdue.length === 1 ? " became" : "s became"} delinquent.`, next => {
    for (const loan of next.loans) {
      if (loan.lenderId === BANK && loan.status === "active" && next.round > Number(loan.dueRound)) {
        loan.status = "delinquent";
        loan.delinquentAt = isoNow();
      }
    }
  }, { loanIds: overdue.map(loan => loan.id), round: state.round }, overdue.map(loan => loan.borrowerId));
}

export function transferCash(state, fromId, toId, amount, memo = "Payment") {
  amount = roundMoney(amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter a positive payment amount.");
  if (fromId === toId) throw new Error("Sender and recipient must be different.");
  return commit(
    state,
    "cash_transfer",
    `${entityName(state, fromId)} paid ${entityName(state, toId)} $${amount} — ${memo}.`,
    next => {
      adjustCash(next, fromId, -amount);
      adjustCash(next, toId, amount);
    },
    { fromId, toId, amount, memo },
    [fromId, toId].filter(id => ![BANK, POT].includes(id))
  );
}

export function passGo(state, playerId, salary = 200) {
  const player = getPlayer(state, playerId);
  if (player.bankrupt || player.mergedInto) throw new Error("Only an active company may collect GO salary.");
  const amount = roundMoney(salary);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("GO salary must be a positive whole-dollar amount.");
  return commit(
    state,
    "passed_go",
    `${player.name} passed GO and collected $${amount}.`,
    next => {
      adjustCash(next, BANK, -amount);
      adjustCash(next, playerId, amount);
    },
    { playerId, amount },
    [playerId]
  );
}

function sharesTotal(shares) {
  return round2(shares.reduce((sum, share) => sum + Number(share.percent || 0), 0));
}

function normalizeShares(shares) {
  return shares
    .filter(share => share.percent > 0.0001)
    .map(share => ({ entityId: share.entityId, percent: round2(share.percent) }))
    .sort((a, b) => a.entityId.localeCompare(b.entityId));
}

export function ownershipSignature(property) {
  return normalizeShares(property.ownerShares || []).map(s => `${s.entityId}:${s.percent}`).join("|");
}

export function transferPropertyShare(state, propertyId, fromId, toId, percent = 100, memo = "Property transfer") {
  percent = round2(Number(percent));
  if (percent <= 0 || percent > 100) throw new Error("Property share must be between 0 and 100%.");
  if (fromId === toId) throw new Error("Transfer parties must be different.");
  const original = state.properties.find(p => p.id === propertyId);
  if (!original) throw new Error("Property not found.");
  if (original.type === "street" && state.properties.some(p => p.type === "street" && p.group === original.group && p.buildings > 0)) {
    throw new Error("Sell all buildings in this color group before transferring a property from it.");
  }
  const fromShare = fromId === BANK ? 100 - sharesTotal(original.ownerShares) : (original.ownerShares.find(s => s.entityId === fromId)?.percent || 0);
  if (fromShare + 0.001 < percent) throw new Error(`${entityName(state, fromId)} does not own ${percent}% of ${original.name}.`);

  const mortgageTransferCharge = original.mortgaged && toId !== BANK ? roundMoney(original.mortgage * 0.10 * percent / 100) : 0;
  return commit(
    state,
    "property_transfer",
    `${entityName(state, fromId)} transferred ${percent}% of ${original.name} to ${entityName(state, toId)} — ${memo}.${mortgageTransferCharge ? ` ${entityName(state, toId)} paid a $${mortgageTransferCharge} mortgage transfer charge.` : ""}`,
    next => {
      const property = next.properties.find(p => p.id === propertyId);
      if (mortgageTransferCharge) {
        adjustCash(next, toId, -mortgageTransferCharge);
        adjustCash(next, BANK, mortgageTransferCharge);
      }
      if (fromId !== BANK) {
        const source = property.ownerShares.find(s => s.entityId === fromId);
        source.percent = round2(source.percent - percent);
      }
      if (toId !== BANK) {
        const target = property.ownerShares.find(s => s.entityId === toId);
        if (target) target.percent = round2(target.percent + percent);
        else property.ownerShares.push({ entityId: toId, percent });
      }
      property.ownerShares = normalizeShares(property.ownerShares);
    },
    { propertyId, fromId, toId, percent, memo, mortgageTransferCharge },
    [fromId, toId].filter(id => id !== BANK)
  );
}

export function acquirePropertyFromBank(state, playerId, propertyId, priceOverride = null) {
  const property = state.properties.find(p => p.id === propertyId);
  if (!property) throw new Error("Property not found.");
  if (sharesTotal(property.ownerShares) > 0) throw new Error("Property is already owned.");
  const price = roundMoney(priceOverride ?? property.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error("Purchase price must be positive.");
  return commit(
    state,
    "property_purchase",
    `${entityName(state, playerId)} purchased ${property.name} from the bank for $${price}.`,
    next => {
      adjustCash(next, playerId, -price);
      adjustCash(next, BANK, price);
      const target = next.properties.find(p => p.id === propertyId);
      target.ownerShares = [{ entityId: playerId, percent: 100 }];
    },
    { playerId, propertyId, price },
    [playerId]
  );
}

export function setMortgage(state, propertyId, mortgaged) {
  const property = state.properties.find(p => p.id === propertyId);
  if (!property) throw new Error("Property not found.");
  if (!property.ownerShares.length) throw new Error("Unowned property cannot be mortgaged.");
  if (mortgaged && property.type === "street" && state.properties.some(p => p.type === "street" && p.group === property.group && p.buildings > 0)) {
    throw new Error("Sell all buildings in this color group before mortgaging any property in it.");
  }
  if (property.mortgaged === mortgaged) return state;
  const owners = property.ownerShares;
  return commit(
    state,
    mortgaged ? "mortgage" : "unmortgage",
    `${property.name} was ${mortgaged ? "mortgaged" : "unmortgaged"}.`,
    next => {
      const target = next.properties.find(p => p.id === propertyId);
      target.mortgaged = mortgaged;
      const total = mortgaged ? roundMoney(target.mortgage) : roundMoney(target.mortgage * 1.1);
      const allocations = allocateMoney(total, target.ownerShares.map(owner => ({ entityId: owner.entityId, weight: owner.percent })));
      for (const allocation of allocations) adjustCash(next, allocation.entityId, mortgaged ? allocation.amount : -allocation.amount);
      adjustCash(next, BANK, mortgaged ? -total : total);
    },
    { propertyId, mortgaged },
    owners.map(o => o.entityId)
  );
}

export function setBuildings(state, propertyId, buildings) {
  buildings = Number(buildings);
  if (!Number.isInteger(buildings) || buildings < 0 || buildings > 5) throw new Error("Buildings must be 0–5, where 5 is a hotel.");
  const property = state.properties.find(p => p.id === propertyId);
  if (!property || property.type !== "street") throw new Error("Only streets can have buildings.");
  if (!property.ownerShares.length) throw new Error("The property must be owned.");
  if (property.mortgaged) throw new Error("A mortgaged property cannot be improved.");
  const group = state.properties.filter(p => p.type === "street" && p.group === property.group);
  if (!hasMonopoly(state, property)) throw new Error("The identical ownership group must control the full color set before building.");
  const delta = buildings - property.buildings;
  if (!delta) return state;
  if (delta > 0) {
    const frozenOwners = property.ownerShares
      .map(share => state.players.find(player => player.id === share.entityId))
      .filter(player => player && Number(player.constructionFreezeUntilRound || 0) >= state.round);
    if (frozenOwners.length) throw new Error(`${frozenOwners.map(player => player.name).join(" and ")} cannot buy new houses or hotels through round ${Math.max(...frozenOwners.map(player => player.constructionFreezeUntilRound))} because of an antitrust order.`);
  }
  if (Math.abs(delta) !== 1) throw new Error("Change buildings one step at a time so even-building can be enforced.");
  const levels = group.map(p => p.buildings);
  if (delta > 0 && property.buildings !== Math.min(...levels)) throw new Error("Build evenly: improve a least-developed property first.");
  if (delta < 0 && property.buildings !== Math.max(...levels)) throw new Error("Sell evenly: reduce a most-developed property first.");
  const cost = Math.abs(delta) * property.buildCost;
  return commit(
    state,
    "buildings_changed",
    `${property.name} changed from ${property.buildings} to ${buildings === 5 ? "a hotel" : `${buildings} house(s)`}.`,
    next => {
      const target = next.properties.find(p => p.id === propertyId);
      if (delta > 0 && property.buildings < 4) {
        if (next.bankSupply.houses < 1) throw new Error("The bank has no houses available; auction or wait for a return.");
        next.bankSupply.houses -= 1;
      } else if (delta > 0 && property.buildings === 4) {
        if (next.bankSupply.hotels < 1) throw new Error("The bank has no hotels available.");
        next.bankSupply.hotels -= 1;
        next.bankSupply.houses += 4;
      } else if (delta < 0 && property.buildings === 5) {
        if (next.bankSupply.houses < 4) throw new Error("The bank lacks four houses needed to break this hotel.");
        next.bankSupply.hotels += 1;
        next.bankSupply.houses -= 4;
      } else if (delta < 0) {
        next.bankSupply.houses += 1;
      }
      const bankAmount = roundMoney(delta > 0 ? cost : -(cost * 0.5));
      const allocations = allocateMoney(Math.abs(bankAmount), target.ownerShares.map(owner => ({ entityId: owner.entityId, weight: owner.percent })));
      for (const allocation of allocations) adjustCash(next, allocation.entityId, delta > 0 ? -allocation.amount : allocation.amount);
      adjustCash(next, BANK, bankAmount);
      target.buildings = buildings;
    },
    { propertyId, previous: property.buildings, buildings, grossCost: cost },
    property.ownerShares.map(o => o.entityId)
  );
}

function hasMonopoly(state, property) {
  if (property.type !== "street" || !property.ownerShares.length) return false;
  const signature = ownershipSignature(property);
  const group = state.properties.filter(p => p.type === "street" && p.group === property.group);
  return group.length === GROUP_SIZES[property.group] && group.every(p => !p.mortgaged && ownershipSignature(p) === signature && sharesTotal(p.ownerShares) === 100);
}

export function calculateRent(state, propertyId, diceTotal = 0) {
  const property = state.properties.find(p => p.id === propertyId);
  if (!property) throw new Error("Property not found.");
  if (!property.ownerShares.length || property.mortgaged) return { total: 0, distributions: [], explanation: "No rent is due." };
  const signature = ownershipSignature(property);
  let total = 0;
  let explanation = "";
  if (property.type === "street") {
    total = property.rents[property.buildings] || 0;
    if (property.buildings === 0 && hasMonopoly(state, property)) total *= 2;
    explanation = property.buildings === 5 ? "Hotel rent" : property.buildings > 0 ? `${property.buildings}-house rent` : hasMonopoly(state, property) ? "Unimproved monopoly rent (2×)" : "Base rent";
  } else if (property.type === "railroad") {
    const count = state.properties.filter(p => p.type === "railroad" && !p.mortgaged && ownershipSignature(p) === signature).length;
    total = [0, 25, 50, 100, 200][count] || 0;
    explanation = `${count} railroad(s) under identical ownership`;
  } else if (property.type === "utility") {
    if (!Number.isFinite(Number(diceTotal)) || Number(diceTotal) < 2) throw new Error("Enter the dice total for utility rent.");
    const count = state.properties.filter(p => p.type === "utility" && !p.mortgaged && ownershipSignature(p) === signature).length;
    const multiplier = count >= 2 ? 10 : 4;
    total = multiplier * Number(diceTotal);
    explanation = `${multiplier}× dice total with ${count} utility/utilities`;
  }
  const roundedTotal = roundMoney(total);
  return {
    total: roundedTotal,
    distributions: allocateMoney(roundedTotal, property.ownerShares.map(share => ({ entityId: share.entityId, weight: share.percent }))),
    explanation
  };
}

export function payRent(state, visitorId, propertyId, diceTotal = 0, discountPercent = 0) {
  const property = state.properties.find(p => p.id === propertyId);
  if (!property) throw new Error("Property not found.");
  const rent = calculateRent(state, propertyId, diceTotal);
  const discount = Math.min(100, Math.max(0, Number(discountPercent || 0)));
  const effectiveOwners = property.ownerShares.map(share => {
    const owner = state.players.find(player => player.id === share.entityId);
    const antitrustFactor = owner && Number(owner.antitrustHalfRentUntilRound || 0) >= state.round ? 0.5 : 1;
    return { entityId: share.entityId, weight: share.percent * antitrustFactor, antitrustFactor, baseAmount: rent.distributions.find(item => item.entityId === share.entityId)?.amount || 0 };
  });
  const totalEffectivePercent = effectiveOwners.reduce((sum, item) => sum + item.weight, 0);
  const total = roundMoney(rent.total * (1 - discount / 100) * totalEffectivePercent / 100);
  const allocations = allocateMoney(total, effectiveOwners);
  const adjustedDistributions = allocations.map(allocation => ({
    entityId: allocation.entityId,
    baseAmount: effectiveOwners.find(item => item.entityId === allocation.entityId)?.baseAmount || 0,
    antitrustFactor: effectiveOwners.find(item => item.entityId === allocation.entityId)?.antitrustFactor || 1,
    amount: allocation.amount
  }));
  if (total <= 0) return commit(state, "rent_waived", `${entityName(state, visitorId)} owed no rent on ${property.name}.`, () => {}, { propertyId, visitorId, rent, discount });
  const visitor = getPlayer(state, visitorId);
  if (visitor.cash < total) throw new Error(`${visitor.name} cannot pay $${total}. Use the rescue/bankruptcy workflow.`);
  const revenuePreview = [];
  const antitrustReduced = adjustedDistributions.some(item => item.antitrustFactor < 1);
  return commit(
    state,
    "rent_paid",
    `${visitor.name} paid $${total} rent on ${property.name}${discount ? ` after a ${discount}% discount` : ""}${antitrustReduced ? " after an antitrust rent reduction" : ""}; shareholder dividends were distributed automatically.`,
    next => {
      adjustCash(next, visitorId, -total);
      for (const distribution of adjustedDistributions) revenuePreview.push(...distributeCompanyRevenue(next, distribution.entityId, distribution.amount));
    },
    { propertyId, visitorId, diceTotal, discountPercent: discount, baseRent: rent.total, total, explanation: rent.explanation, antitrustReduced, adjustedDistributions, dividendRate: state.settings.stockDividendRate, revenueAllocations: revenuePreview },
    [visitorId, ...adjustedDistributions.map(item => item.entityId)]
  );
}


export function recordVoiceNote(state, transcript, category = "note", summary = "", extra = {}) {
  const cleanTranscript = String(transcript || "").trim();
  if (!cleanTranscript) throw new Error("Voice note transcript cannot be blank.");
  const cleanCategory = String(category || "note").trim().slice(0, 40) || "note";
  const cleanSummary = String(summary || cleanTranscript).trim().slice(0, 240);
  return commit(
    state,
    "voice_note",
    `Voice ${cleanCategory.replaceAll("_", " ")} — ${cleanSummary}.`,
    () => {},
    {
      transcript: cleanTranscript.slice(0, 5000),
      category: cleanCategory,
      summary: cleanSummary,
      source: String(extra.source || "speech").slice(0, 40),
      model: String(extra.model || "local").slice(0, 120),
      confidence: Math.max(0, Math.min(1, Number(extra.confidence ?? 1))),
      voice: true
    },
    Array.isArray(extra.actorIds) ? extra.actorIds : []
  );
}

export function advanceTurn(state, rng = Math.random) {
  const beforeRound = state.round;
  let nextState = commit(state, "turn_advanced", "Turn advanced.", next => {
    let attempts = 0;
    do {
      next.activePlayerIndex = (next.activePlayerIndex + 1) % next.players.length;
      if (next.activePlayerIndex === 0) next.round += 1;
      attempts += 1;
    } while ((next.players[next.activePlayerIndex].bankrupt || next.players[next.activePlayerIndex].mergedInto) && attempts <= next.players.length);
    for (const deal of next.deals || []) refreshDealReadiness(next, deal);
    for (const policy of next.policies || []) refreshPolicyReadiness(next, policy);
    for (const merger of next.mergers || []) refreshMergerReadiness(next, merger);
  });
  if (nextState.round > beforeRound) {
    nextState = updateStockMarket(nextState, rng);
    nextState = updateBankLendingMarket(nextState, rng);
    nextState = createTaxBillsForRound(nextState);
    nextState = markDelinquentBankLoans(nextState);
  }
  return nextState;
}


export function assetEstimatedValue(state, asset) {
  if (asset.type === "cash") return Number(asset.amount || 0);
  if (asset.type === "property_share") {
    const property = state.properties.find(p => p.id === asset.propertyId);
    if (!property) return 0;
    const equity = property.price + (property.buildings || 0) * (property.buildCost || 0) - (property.mortgaged ? property.mortgage : 0);
    return equity * Number(asset.percent || 100) / 100;
  }
  if (asset.type === "company_share") {
    try { return stockMarketValue(state, asset.companyId, Number(asset.shares || 0)); } catch { return 0; }
  }
  if (asset.type === "jail_card") return 50 * Number(asset.quantity || 1);
  if (asset.type === "loan") return Number(asset.principal || 0);
  return 0;
}

export function dealFairness(state, deal) {
  const a = (deal.proposerGives || []).reduce((sum, asset) => sum + assetEstimatedValue(state, asset), 0);
  const b = (deal.counterpartyGives || []).reduce((sum, asset) => sum + assetEstimatedValue(state, asset), 0);
  const max = Math.max(a, b, 1);
  const imbalance = Math.abs(a - b) / max;
  return { proposerValue: roundMoney(a), counterpartyValue: roundMoney(b), imbalance: round2(imbalance) };
}

export const APPROVAL_CONDITIONS = [
  "Add one extra settlement round.",
  "Require more than 60% of applicable record-date voting shares to vote YES.",
  "Grant one temporary rent-relief obligation stated in the final filing.",
  "Keep one named asset locked until settlement completes.",
  "Make the complete final filing publicly visible in the ledger."
];

function fixedApprovalResult(rng = Math.random) {
  const draw = Math.max(0, Math.min(0.999999, Number(rng())));
  const percentile = Math.floor(draw * 100) + 1;
  if (draw < 0.10) return { outcome: "approved", percentile, condition: null };
  if (draw < 0.50) return { outcome: "approved_with_conditions", percentile, condition: null };
  return { outcome: "rejected", percentile, condition: null };
}

export function randomizeDealApproval(state, deal, rng = Math.random) {
  if (deal.approval?.rolledAt) throw new Error("This unchanged proposal has already received an approval result.");
  const result = fixedApprovalResult(rng);
  return {
    ...result,
    probabilityRule: "10% approved · 40% conditional · 50% rejected",
    condition: result.outcome === "approved_with_conditions" ? "AI condition pending." : null
  };
}

function votingSnapshot(state, companyId) {
  const stock = getStock(state, companyId);
  return {
    companyId,
    outstandingShares: stock.outstandingShares,
    holdings: clone(stock.holdings),
    capturedRound: state.round
  };
}

export function weightedVoteSummary(snapshot, votes = {}, thresholdPercent = 50) {
  if (!snapshot) return { yes: 0, no: 0, abstain: 0, total: 0, yesPercent: 0, passed: true, thresholdPercent };
  let yes = 0, no = 0;
  for (const holding of snapshot.holdings || []) {
    const vote = votes[holding.entityId];
    if (vote === "yes") yes += holding.shares;
    if (vote === "no") no += holding.shares;
  }
  const total = Number(snapshot.outstandingShares || 0);
  const abstain = Math.max(0, total - yes - no);
  const yesPercent = total ? yes / total * 100 : 0;
  return { yes: round2(yes), no: round2(no), abstain: round2(abstain), total: round2(total), yesPercent: round2(yesPercent), passed: yesPercent > thresholdPercent, thresholdPercent };
}

function dealVotePassed(deal) {
  return (deal.requiredCompanyVoteIds || []).every(companyId => weightedVoteSummary(deal.voteSnapshots?.[companyId], deal.votes?.[companyId], deal.voteThresholdPercent || 50).passed);
}

function approvalSatisfied(deal) {
  if (deal.approval.outcome === "approved") return true;
  if (deal.approval.outcome !== "approved_with_conditions") return false;
  if (!deal.approval.condition || deal.approval.condition === "AI condition pending.") return false;
  return [deal.proposerId, deal.counterpartyId].every(id => deal.approval.conditionAcceptedBy.includes(id));
}

function refreshDealReadiness(next, target) {
  const signed = Boolean(target.signatures[target.proposerId] && target.signatures[target.counterpartyId]);
  if (!signed || !approvalSatisfied(target) || !dealVotePassed(target) || ["rejected", "cancelled", "executed"].includes(target.status)) return;
  if (!target.settlementRound) {
    target.readyRound = next.round;
    target.settlementRound = next.round + Number(next.settings.dealSettlementLagRounds ?? GAME_DEFAULTS.dealSettlementLagRounds) + Number(target.extraSettlementRounds || 0);
  }
  target.status = next.round >= target.settlementRound ? "ready_to_settle" : "pending_settlement";
}

const CLOSED_DEAL_STATUSES = ["rejected", "cancelled", "executed"];

function assertDealAssets(state, giverId, assets) {
  for (const asset of assets) {
    if (asset.type === "cash") {
      if (!(Number(asset.amount) > 0)) throw new Error("Cash promised in a deal must be a positive amount.");
    } else if (asset.type === "property_share") {
      const property = state.properties.find(p => p.id === asset.propertyId);
      if (!property) throw new Error("Deal property not found.");
      const percent = Number(asset.percent ?? 100);
      if (!(percent > 0) || percent > 100) throw new Error("Property share must be between 0 and 100%.");
      const owned = property.ownerShares.find(share => share.entityId === giverId)?.percent || 0;
      if (owned + 0.001 < percent) throw new Error(`${entityName(state, giverId)} does not own ${percent}% of ${property.name}.`);
    } else if (asset.type === "company_share") {
      const stock = getStock(state, asset.companyId);
      if (stock.status !== "active") throw new Error(`${stock.ticker} is no longer actively traded.`);
      if (!(Number(asset.shares) > 0)) throw new Error("Share quantity must be positive.");
      if (!asset.issuance && stockHolding(stock, giverId) + 0.001 < Number(asset.shares)) throw new Error(`${entityName(state, giverId)} does not own ${asset.shares} shares of ${stock.ticker}.`);
    } else if (asset.type === "jail_card") {
      if (getPlayer(state, giverId).jailFreeCards < Number(asset.quantity || 1)) throw new Error(`${entityName(state, giverId)} lacks the promised Get Out of Jail Free card(s).`);
    } else {
      throw new Error(`Unsupported deal asset type: ${asset.type}.`);
    }
  }
}

export function createDeal(state, input) {
  const proposerId = input.proposerId;
  const counterpartyId = input.counterpartyId;
  const proposerGives = clone(input.proposerGives || []);
  const counterpartyGives = clone(input.counterpartyGives || []);
  const requiredCompanyVoteIds = [...new Set([
    ...(input.requiredCompanyVoteIds || []),
    ...proposerGives.filter(asset => asset.type === "company_share" && asset.issuance).map(asset => asset.companyId),
    ...counterpartyGives.filter(asset => asset.type === "company_share" && asset.issuance).map(asset => asset.companyId)
  ])];
  const legalFee = roundMoney(input.legalFee ?? state.settings.legalFee ?? GAME_DEFAULTS.legalFee);
  const deal = {
    id: uid("deal"),
    kind: input.kind || "deal",
    title: String(input.title || "Untitled deal").trim(),
    proposerId,
    counterpartyId,
    proposerGives,
    counterpartyGives,
    terms: String(input.terms || "").trim(),
    status: "proposed",
    signatures: {},
    approval: {
      outcome: null,
      percentile: null,
      probabilityRule: "10% approved · 40% conditional · 50% rejected",
      condition: null,
      conditionSource: null,
      conditionData: null,
      conditionAcceptedBy: [],
      rolledAt: null
    },
    requiredCompanyVoteIds,
    voteSnapshots: Object.fromEntries(requiredCompanyVoteIds.map(companyId => [companyId, votingSnapshot(state, companyId)])),
    votes: Object.fromEntries(requiredCompanyVoteIds.map(companyId => [companyId, {}])),
    voteThresholdPercent: Number(input.voteThresholdPercent ?? 50),
    legalFee,
    createdRound: state.round,
    readyRound: null,
    settlementRound: null,
    extraSettlementRounds: 0,
    createdAt: isoNow(),
    executedAt: null
  };
  if (!deal.proposerId || !deal.counterpartyId || deal.proposerId === deal.counterpartyId) throw new Error("Choose two different players.");
  getPlayer(state, deal.proposerId);
  getPlayer(state, deal.counterpartyId);
  if (!(deal.proposerGives.length || deal.counterpartyGives.length || deal.terms)) throw new Error("Add at least one asset or contract term.");
  assertDealAssets(state, deal.proposerId, deal.proposerGives);
  assertDealAssets(state, deal.counterpartyId, deal.counterpartyGives);
  return commit(state, "deal_created", `${entityName(state, deal.proposerId)} filed “${deal.title}” with ${entityName(state, deal.counterpartyId)}. A $${legalFee} legal fee was paid.`, next => {
    chargeFee(next, deal.proposerId, legalFee, "Deal legal fee");
    next.deals.unshift(deal);
  }, { dealId: deal.id, legalFee, requiredCompanyVoteIds }, [deal.proposerId, deal.counterpartyId]);
}

export function createPrimaryStockOffering(state, input) {
  const stock = getStock(state, input.companyId);
  const shares = round2(Number(input.shares));
  if (input.companyId === input.buyerId) throw new Error("A company cannot raise new capital from itself.");
  if (!Number.isFinite(shares) || shares <= 0) throw new Error("Enter a positive number of shares.");
  if (stock.outstandingShares + shares > stock.authorizedShares + 0.001) throw new Error(`${stock.ticker} has only ${round2(stock.authorizedShares - stock.outstandingShares)} authorized shares available.`);
  const total = roundMoney(stock.price * shares);
  return createDeal(state, {
    kind: "primary_stock_offering",
    title: `${stock.ticker} primary offering — ${shares} shares`,
    proposerId: input.companyId,
    counterpartyId: input.buyerId,
    proposerGives: [{ type: "company_share", companyId: input.companyId, shares, issuance: true, lockedPrice: stock.price }],
    counterpartyGives: [{ type: "cash", amount: total }],
    terms: `The buyer receives ${shares} newly issued voting shares of ${stock.ticker} at the locked market price of $${stock.price} per share. Proceeds may be used for property purchases, houses, hotels, taxes, or other company expenses.`,
    requiredCompanyVoteIds: [input.companyId]
  });
}

export function createSecondaryStockTrade(state, input) {
  const stock = getStock(state, input.companyId);
  const shares = round2(Number(input.shares));
  if (input.sellerId === input.buyerId) throw new Error("Seller and buyer must differ.");
  if (stockHolding(stock, input.sellerId) + 0.001 < shares) throw new Error(`${entityName(state, input.sellerId)} does not own ${shares} shares of ${stock.ticker}.`);
  const total = roundMoney(stock.price * shares);
  return createDeal(state, {
    kind: "secondary_stock_trade",
    title: `${stock.ticker} trade — ${shares} shares`,
    proposerId: input.sellerId,
    counterpartyId: input.buyerId,
    proposerGives: [{ type: "company_share", companyId: input.companyId, shares, issuance: false, lockedPrice: stock.price }],
    counterpartyGives: [{ type: "cash", amount: total }],
    terms: `${shares} existing voting shares of ${stock.ticker} trade at the locked market price of $${stock.price} per share. The market may move before two-round settlement, but the trade price remains locked.`
  });
}

export function signDeal(state, dealId, playerId) {
  const deal = state.deals.find(d => d.id === dealId);
  if (!deal) throw new Error("Deal not found.");
  if (![deal.proposerId, deal.counterpartyId].includes(playerId)) throw new Error("Only deal parties may sign.");
  if (CLOSED_DEAL_STATUSES.includes(deal.status)) throw new Error(`A ${deal.status} proposal cannot be signed.`);
  return commit(state, "deal_signed", `${entityName(state, playerId)} accepted the current version of “${deal.title}”.`, next => {
    const target = next.deals.find(d => d.id === dealId);
    target.signatures[playerId] = isoNow();
    refreshDealReadiness(next, target);
  }, { dealId, playerId }, [playerId]);
}

export function rollDealApproval(state, dealId, rng = Math.random) {
  const deal = state.deals.find(d => d.id === dealId);
  if (!deal) throw new Error("Deal not found.");
  const result = randomizeDealApproval(state, deal, rng);
  return commit(state, "deal_randomized", `Approval result for “${deal.title}”: ${result.outcome.replaceAll("_", " ")} under the fixed 10/40/50 rule.`, next => {
    const target = next.deals.find(d => d.id === dealId);
    Object.assign(target.approval, result, { rolledAt: isoNow(), conditionAcceptedBy: [], conditionSource: result.outcome === "approved_with_conditions" ? "pending_ai" : null });
    if (result.outcome === "rejected") target.status = "rejected";
    else if (result.outcome === "approved_with_conditions") {
      target.status = "condition_pending";
      target.signatures = {};
      target.votes = Object.fromEntries((target.requiredCompanyVoteIds || []).map(companyId => [companyId, {}]));
    } else {
      target.status = "approved_for_signatures";
      refreshDealReadiness(next, target);
    }
  }, { dealId, ...result }, [deal.proposerId, deal.counterpartyId]);
}

export function setDealApprovalCondition(state, dealId, condition, source = "deepseek", conditionData = null) {
  const text = String(condition || "").trim();
  if (!text) throw new Error("Approval condition cannot be blank.");
  const deal = state.deals.find(d => d.id === dealId);
  if (!deal || deal.approval.outcome !== "approved_with_conditions") throw new Error("This deal is not awaiting a condition.");
  if (CLOSED_DEAL_STATUSES.includes(deal.status)) throw new Error(`A ${deal.status} proposal cannot be changed.`);
  return commit(state, "deal_condition_defined", `The approval condition for “${deal.title}” was defined.`, next => {
    const target = next.deals.find(d => d.id === dealId);
    target.approval.condition = text;
    target.approval.conditionSource = source;
    target.approval.conditionData = clone(conditionData);
    if (conditionData?.mechanic === "supermajority_vote") target.voteThresholdPercent = Math.max(target.voteThresholdPercent || 50, Number(conditionData.value || 60));
    if (conditionData?.mechanic === "extra_settlement_round") target.extraSettlementRounds = Math.max(target.extraSettlementRounds || 0, Number(conditionData.value || 1));
    target.approval.conditionAcceptedBy = [];
    // R-03: a material condition cancels earlier consent, votes, and any settlement clock.
    target.signatures = {};
    target.votes = Object.fromEntries((target.requiredCompanyVoteIds || []).map(companyId => [companyId, {}]));
    target.readyRound = null;
    target.settlementRound = null;
    target.status = "condition_review";
  }, { dealId, condition: text, source, conditionData }, [deal.proposerId, deal.counterpartyId]);
}

export function applyFallbackDealCondition(state, dealId, rng = Math.random) {
  const condition = APPROVAL_CONDITIONS[Math.floor(rng() * APPROVAL_CONDITIONS.length)] || APPROVAL_CONDITIONS[0];
  return setDealApprovalCondition(state, dealId, condition, "local_fallback");
}

export function acceptDealCondition(state, dealId, playerId) {
  const deal = state.deals.find(d => d.id === dealId);
  if (!deal || deal.approval.outcome !== "approved_with_conditions") throw new Error("No conditional approval is awaiting acceptance.");
  if (CLOSED_DEAL_STATUSES.includes(deal.status)) throw new Error(`A ${deal.status} proposal cannot be changed.`);
  if (!deal.approval.condition || deal.approval.condition === "AI condition pending.") throw new Error("The AI condition has not been defined yet.");
  if (![deal.proposerId, deal.counterpartyId].includes(playerId)) throw new Error("Only deal parties may accept the condition.");
  return commit(state, "condition_accepted", `${entityName(state, playerId)} accepted the condition for “${deal.title}”.`, next => {
    const target = next.deals.find(d => d.id === dealId);
    if (!target.approval.conditionAcceptedBy.includes(playerId)) target.approval.conditionAcceptedBy.push(playerId);
    refreshDealReadiness(next, target);
  }, { dealId, playerId }, [playerId]);
}

export function castDealVote(state, dealId, companyId, voterId, vote) {
  if (!["yes", "no"].includes(vote)) throw new Error("Vote must be yes or no.");
  const deal = state.deals.find(d => d.id === dealId);
  if (!deal) throw new Error("Deal not found.");
  if (CLOSED_DEAL_STATUSES.includes(deal.status)) throw new Error(`A ${deal.status} proposal cannot be voted on.`);
  if (!approvalSatisfied(deal)) throw new Error("Regulatory approval must be resolved before shareholder voting.");
  const snapshot = deal.voteSnapshots?.[companyId];
  if (!snapshot) throw new Error("This company does not vote on the proposal.");
  if (!snapshot.holdings.some(item => item.entityId === voterId && item.shares > 0)) throw new Error("Only shareholders on the proposal record date may vote.");
  return commit(state, "shareholder_vote", `${entityName(state, voterId)} voted ${vote.toUpperCase()} on “${deal.title}” for ${getStock(state, companyId).ticker}.`, next => {
    const target = next.deals.find(d => d.id === dealId);
    target.votes[companyId][voterId] = vote;
    refreshDealReadiness(next, target);
  }, { dealId, companyId, voterId, vote }, [voterId, companyId]);
}

function executeAsset(next, fromId, toId, asset) {
  if (asset.type === "cash") {
    adjustCash(next, fromId, -Number(asset.amount));
    adjustCash(next, toId, Number(asset.amount));
    return;
  }
  if (asset.type === "property_share") {
    const property = next.properties.find(p => p.id === asset.propertyId);
    if (!property) throw new Error("Deal property not found.");
    if (property.type === "street" && next.properties.some(p => p.type === "street" && p.group === property.group && p.buildings > 0)) {
      throw new Error("Sell all buildings in this color group before transferring a property from it.");
    }
    const percent = Number(asset.percent || 100);
    const mortgageTransferCharge = property.mortgaged ? roundMoney(property.mortgage * 0.10 * percent / 100) : 0;
    if (mortgageTransferCharge) {
      adjustCash(next, toId, -mortgageTransferCharge);
      adjustCash(next, BANK, mortgageTransferCharge);
    }
    const source = property.ownerShares.find(s => s.entityId === fromId);
    if (!source || source.percent < percent) throw new Error(`${entityName(next, fromId)} no longer owns the promised share of ${property.name}.`);
    source.percent -= percent;
    const target = property.ownerShares.find(s => s.entityId === toId);
    if (target) target.percent += percent;
    else property.ownerShares.push({ entityId: toId, percent });
    property.ownerShares = normalizeShares(property.ownerShares);
    return;
  }
  if (asset.type === "company_share") {
    transferStockShares(next, asset.companyId, fromId, toId, asset.shares, Boolean(asset.issuance));
    return;
  }
  if (asset.type === "jail_card") {
    const from = getPlayer(next, fromId);
    const to = getPlayer(next, toId);
    const quantity = Number(asset.quantity || 1);
    if (from.jailFreeCards < quantity) throw new Error(`${from.name} lacks the promised Get Out of Jail Free card(s).`);
    from.jailFreeCards -= quantity;
    to.jailFreeCards += quantity;
  }
}

export function executeDeal(state, dealId) {
  const deal = state.deals.find(d => d.id === dealId);
  if (!deal) throw new Error("Deal not found.");
  if (!(deal.signatures[deal.proposerId] && deal.signatures[deal.counterpartyId])) throw new Error("Both players must accept the final deal.");
  if (!approvalSatisfied(deal)) throw new Error("The deal lacks final approval and accepted conditions.");
  if (!dealVotePassed(deal)) throw new Error("The required shareholder vote has not passed.");
  if (!deal.settlementRound) throw new Error("The two-round settlement clock has not started.");
  if (state.round < deal.settlementRound) throw new Error(`This deal settles in round ${deal.settlementRound}.`);
  if (deal.status === "executed") throw new Error("Deal has already executed.");

  return commit(state, "deal_executed", `Settled “${deal.title}” after the required two-round lag.`, next => {
    const target = next.deals.find(d => d.id === dealId);
    for (const asset of target.proposerGives) executeAsset(next, target.proposerId, target.counterpartyId, asset);
    for (const asset of target.counterpartyGives) executeAsset(next, target.counterpartyId, target.proposerId, asset);
    target.status = "executed";
    target.executedAt = isoNow();
    if (target.terms || target.approval.condition) {
      next.contracts.unshift({
        id: uid("contract"),
        title: target.title,
        type: target.kind || "deal",
        partyIds: [target.proposerId, target.counterpartyId],
        terms: [target.terms, target.approval.condition ? `Approval condition: ${target.approval.condition}` : ""].filter(Boolean).join("\n"),
        status: "active",
        createdRound: target.createdRound,
        effectiveRound: target.settlementRound,
        expiresRound: null,
        linkedDealId: target.id,
        signatures: clone(target.signatures),
        legalFeePaid: target.legalFee,
        createdAt: isoNow()
      });
    }
  }, { dealId, settlementRound: deal.settlementRound }, [deal.proposerId, deal.counterpartyId]);
}


export function createContract(state, input) {
  const partyIds = [...new Set(input.partyIds || [])];
  if (partyIds.length < 1) throw new Error("Select at least one contract party.");
  for (const partyId of partyIds) getPlayer(state, partyId);
  const sponsorId = input.sponsorId || partyIds[0];
  getPlayer(state, sponsorId);
  const legalFee = roundMoney(input.legalFee ?? state.settings.legalFee ?? GAME_DEFAULTS.legalFee);
  const contract = {
    id: uid("contract"),
    title: String(input.title || "Untitled contract").trim(),
    type: input.type || "custom",
    partyIds,
    sponsorId,
    terms: String(input.terms || "").trim(),
    status: input.status || "draft",
    createdRound: state.round,
    effectiveRound: input.status === "active" ? state.round : null,
    expiresRound: input.expiresRound ? Number(input.expiresRound) : null,
    linkedDealId: input.linkedDealId || null,
    signatures: clone(input.signatures || {}),
    legalFeePaid: legalFee,
    createdAt: isoNow()
  };
  if (!contract.terms) throw new Error("Contract terms cannot be blank.");
  return commit(state, "contract_created", `Created contract “${contract.title}” and paid a $${legalFee} legal fee.`, next => {
    chargeFee(next, sponsorId, legalFee, "Contract legal fee");
    next.contracts.unshift(contract);
  }, { contractId: contract.id, legalFee, sponsorId }, partyIds);
}


export function updateContractStatus(state, contractId, status) {
  const allowed = ["draft", "active", "fulfilled", "breached", "voided", "expired", "disputed"];
  if (!allowed.includes(status)) throw new Error("Invalid contract status.");
  const contract = state.contracts.find(c => c.id === contractId);
  if (!contract) throw new Error("Contract not found.");
  return commit(state, "contract_status", `Contract “${contract.title}” marked ${status}.`, next => next.contracts.find(c => c.id === contractId).status = status, { contractId, status }, contract.partyIds);
}

function policyApprovalSatisfied(policy) {
  if (policy.approval.outcome === "approved") return true;
  return policy.approval.outcome === "approved_with_conditions" && policy.approval.condition && policy.approval.condition !== "AI condition pending.";
}

function refreshPolicyReadiness(next, policy) {
  const vote = weightedVoteSummary(policy.voteSnapshot, policy.votes, policy.voteThresholdPercent || 50);
  if (!policyApprovalSatisfied(policy) || !vote.passed || ["rejected", "active", "cancelled"].includes(policy.status)) return;
  if (!policy.effectiveRound) {
    policy.readyRound = next.round;
    policy.effectiveRound = next.round + Number(next.settings.dealSettlementLagRounds ?? GAME_DEFAULTS.dealSettlementLagRounds) + Number(policy.extraSettlementRounds || 0);
  }
  policy.status = next.round >= policy.effectiveRound ? "ready_to_activate" : "pending_effective_date";
}

export function createPolicy(state, input) {
  const companyId = input.companyId;
  getPlayer(state, companyId);
  const legalFee = roundMoney(input.legalFee ?? state.settings.legalFee ?? GAME_DEFAULTS.legalFee);
  const policy = {
    id: uid("policy"),
    companyId,
    title: String(input.title || "Corporate policy").trim(),
    type: input.type || "custom",
    terms: String(input.terms || "").trim(),
    status: "proposed",
    approval: { outcome: null, percentile: null, probabilityRule: "10% approved · 40% conditional · 50% rejected", condition: null, conditionSource: null, conditionData: null, rolledAt: null },
    voteSnapshot: votingSnapshot(state, companyId),
    votes: {},
    voteThresholdPercent: Number(input.voteThresholdPercent ?? 50),
    legalFee,
    createdRound: state.round,
    readyRound: null,
    effectiveRound: null,
    extraSettlementRounds: 0,
    createdAt: isoNow()
  };
  if (!policy.terms) throw new Error("Policy terms cannot be blank.");
  return commit(state, "policy_created", `${entityName(state, companyId)} filed policy “${policy.title}” and paid a $${legalFee} legal fee.`, next => {
    chargeFee(next, companyId, legalFee, "Policy legal fee");
    next.policies.unshift(policy);
  }, { policyId: policy.id, companyId, legalFee }, [companyId]);
}

export function rollPolicyApproval(state, policyId, rng = Math.random) {
  const policy = state.policies.find(item => item.id === policyId);
  if (!policy) throw new Error("Policy not found.");
  if (policy.approval.rolledAt) throw new Error("This policy already received an approval result.");
  const result = fixedApprovalResult(rng);
  return commit(state, "policy_randomized", `Approval result for policy “${policy.title}”: ${result.outcome.replaceAll("_", " ")}.`, next => {
    const target = next.policies.find(item => item.id === policyId);
    Object.assign(target.approval, result, {
      probabilityRule: "10% approved · 40% conditional · 50% rejected",
      condition: result.outcome === "approved_with_conditions" ? "AI condition pending." : null,
      conditionSource: result.outcome === "approved_with_conditions" ? "pending_ai" : null,
      rolledAt: isoNow()
    });
    target.votes = {};
    target.status = result.outcome === "rejected" ? "rejected" : result.outcome === "approved" ? "shareholder_vote" : "condition_pending";
  }, { policyId, ...result }, [policy.companyId]);
}

export function setPolicyApprovalCondition(state, policyId, condition, source = "deepseek", conditionData = null) {
  const text = String(condition || "").trim();
  const policy = state.policies.find(item => item.id === policyId);
  if (!policy || policy.approval.outcome !== "approved_with_conditions") throw new Error("This policy is not awaiting a condition.");
  if (!text) throw new Error("Policy condition cannot be blank.");
  return commit(state, "policy_condition_defined", `The condition for policy “${policy.title}” was defined.`, next => {
    const target = next.policies.find(item => item.id === policyId);
    target.approval.condition = text;
    target.approval.conditionSource = source;
    target.approval.conditionData = clone(conditionData);
    if (conditionData?.mechanic === "supermajority_vote") target.voteThresholdPercent = Math.max(target.voteThresholdPercent || 50, Number(conditionData.value || 60));
    if (conditionData?.mechanic === "extra_settlement_round") target.extraSettlementRounds = Math.max(target.extraSettlementRounds || 0, Number(conditionData.value || 1));
    target.status = "shareholder_vote";
    target.votes = {};
    target.readyRound = null;
    target.effectiveRound = null;
  }, { policyId, condition: text, source, conditionData }, [policy.companyId]);
}

export function castPolicyVote(state, policyId, voterId, vote) {
  if (!["yes", "no"].includes(vote)) throw new Error("Vote must be yes or no.");
  const policy = state.policies.find(item => item.id === policyId);
  if (!policy) throw new Error("Policy not found.");
  if (!policyApprovalSatisfied(policy)) throw new Error("Regulatory approval must be resolved before shareholder voting.");
  if (!policy.voteSnapshot.holdings.some(item => item.entityId === voterId && item.shares > 0)) throw new Error("Only record-date shareholders may vote.");
  return commit(state, "policy_vote", `${entityName(state, voterId)} voted ${vote.toUpperCase()} on policy “${policy.title}”.`, next => {
    const target = next.policies.find(item => item.id === policyId);
    target.votes[voterId] = vote;
    refreshPolicyReadiness(next, target);
  }, { policyId, voterId, vote }, [voterId, policy.companyId]);
}

export function activatePolicy(state, policyId) {
  const policy = state.policies.find(item => item.id === policyId);
  if (!policy) throw new Error("Policy not found.");
  const vote = weightedVoteSummary(policy.voteSnapshot, policy.votes, policy.voteThresholdPercent || 50);
  if (!policyApprovalSatisfied(policy) || !vote.passed) throw new Error("The policy lacks regulatory approval or a passing shareholder vote.");
  if (!policy.effectiveRound || state.round < policy.effectiveRound) throw new Error(`This policy becomes effective in round ${policy.effectiveRound || "—"}.`);
  return commit(state, "policy_activated", `Policy “${policy.title}” became effective after the two-round lag.`, next => {
    next.policies.find(item => item.id === policyId).status = "active";
  }, { policyId, effectiveRound: policy.effectiveRound }, [policy.companyId]);
}

function mergerVotePassed(merger) {
  return [merger.acquirerId, merger.targetId].every(companyId => weightedVoteSummary(merger.voteSnapshots[companyId], merger.votes[companyId], merger.voteThresholdPercent || 50).passed);
}

function mergerApprovalSatisfied(merger) {
  if (merger.approval.outcome === "approved") return true;
  if (merger.approval.outcome !== "approved_with_conditions") return false;
  if (!merger.approval.condition || merger.approval.condition === "AI condition pending.") return false;
  return [merger.acquirerId, merger.targetId].every(id => merger.approval.conditionAcceptedBy.includes(id));
}

function refreshMergerReadiness(next, merger) {
  const consented = Boolean(merger.consents[merger.acquirerId] && merger.consents[merger.targetId]);
  if (!consented || !mergerApprovalSatisfied(merger) || !mergerVotePassed(merger) || ["rejected", "executed", "cancelled"].includes(merger.status)) return;
  if (!merger.settlementRound) {
    merger.readyRound = next.round;
    merger.settlementRound = next.round + Number(next.settings.dealSettlementLagRounds ?? GAME_DEFAULTS.dealSettlementLagRounds) + Number(merger.extraSettlementRounds || 0);
  }
  merger.status = next.round >= merger.settlementRound ? "ready_to_merge" : "pending_settlement";
}

export function createMerger(state, input) {
  const acquirerId = input.acquirerId;
  const targetId = input.targetId;
  if (!acquirerId || !targetId || acquirerId === targetId) throw new Error("Choose two different active companies.");
  const acquirer = getPlayer(state, acquirerId);
  const target = getPlayer(state, targetId);
  if (acquirer.mergedInto || target.mergedInto || acquirer.bankrupt || target.bankrupt) throw new Error("Only active independent companies may merge.");
  if (state.mergers.some(item => !["rejected", "executed", "cancelled"].includes(item.status) && [item.acquirerId, item.targetId].some(id => [acquirerId, targetId].includes(id)))) throw new Error("One of these companies already has a pending merger.");
  const acquirerStock = getStock(state, acquirerId);
  const targetStock = getStock(state, targetId);
  const exchangeRatio = round2(targetStock.price / Math.max(acquirerStock.price, 1));
  const legalFee = roundMoney(state.settings.legalFee ?? GAME_DEFAULTS.legalFee);
  const mergerFee = roundMoney(state.settings.mergerFee ?? GAME_DEFAULTS.mergerFee);
  const merger = {
    id: uid("merger"),
    title: String(input.title || `${acquirerStock.ticker} / ${targetStock.ticker} merger`).trim(),
    acquirerId,
    targetId,
    exchangeRatio,
    lockedAcquirerPrice: acquirerStock.price,
    lockedTargetPrice: targetStock.price,
    status: "proposed",
    approval: { outcome: null, percentile: null, probabilityRule: "10% approved · 40% conditional · 50% rejected", condition: null, conditionSource: null, conditionData: null, conditionAcceptedBy: [], rolledAt: null },
    consents: {},
    voteSnapshots: { [acquirerId]: votingSnapshot(state, acquirerId), [targetId]: votingSnapshot(state, targetId) },
    votes: { [acquirerId]: {}, [targetId]: {} },
    voteThresholdPercent: 50,
    legalFee,
    mergerFee,
    createdRound: state.round,
    readyRound: null,
    settlementRound: null,
    extraSettlementRounds: 0,
    createdAt: isoNow(),
    executedAt: null
  };
  return commit(state, "merger_created", `${acquirerStock.ticker} proposed acquiring ${targetStock.ticker}; $${roundMoney(legalFee + mergerFee)} in legal and merger fees entered the Free Parking pot.`, next => {
    chargeFee(next, acquirerId, legalFee, "Merger legal fee");
    chargeFee(next, acquirerId, mergerFee, "Merger filing fee");
    next.mergers.unshift(merger);
  }, { mergerId: merger.id, legalFee, mergerFee, exchangeRatio }, [acquirerId, targetId]);
}

export function rollMergerApproval(state, mergerId, rng = Math.random) {
  const merger = state.mergers.find(item => item.id === mergerId);
  if (!merger) throw new Error("Merger not found.");
  if (merger.approval.rolledAt) throw new Error("This merger already received an approval result.");
  const result = fixedApprovalResult(rng);
  return commit(state, "merger_randomized", `Approval result for “${merger.title}”: ${result.outcome.replaceAll("_", " ")}.`, next => {
    const target = next.mergers.find(item => item.id === mergerId);
    Object.assign(target.approval, result, {
      probabilityRule: "10% approved · 40% conditional · 50% rejected",
      condition: result.outcome === "approved_with_conditions" ? "AI condition pending." : null,
      conditionSource: result.outcome === "approved_with_conditions" ? "pending_ai" : null,
      conditionAcceptedBy: [],
      rolledAt: isoNow()
    });
    target.consents = {};
    target.votes = { [target.acquirerId]: {}, [target.targetId]: {} };
    target.status = result.outcome === "rejected" ? "rejected" : result.outcome === "approved" ? "awaiting_consent_and_votes" : "condition_pending";
  }, { mergerId, ...result }, [merger.acquirerId, merger.targetId]);
}

export function setMergerApprovalCondition(state, mergerId, condition, source = "deepseek", conditionData = null) {
  const text = String(condition || "").trim();
  const merger = state.mergers.find(item => item.id === mergerId);
  if (!merger || merger.approval.outcome !== "approved_with_conditions") throw new Error("This merger is not awaiting a condition.");
  if (["rejected", "executed", "cancelled"].includes(merger.status)) throw new Error(`A ${merger.status} merger cannot be changed.`);
  if (!text) throw new Error("Merger condition cannot be blank.");
  return commit(state, "merger_condition_defined", `The condition for “${merger.title}” was defined.`, next => {
    const target = next.mergers.find(item => item.id === mergerId);
    target.approval.condition = text;
    target.approval.conditionSource = source;
    target.approval.conditionData = clone(conditionData);
    if (conditionData?.mechanic === "supermajority_vote") target.voteThresholdPercent = Math.max(target.voteThresholdPercent || 50, Number(conditionData.value || 60));
    if (conditionData?.mechanic === "extra_settlement_round") target.extraSettlementRounds = Math.max(target.extraSettlementRounds || 0, Number(conditionData.value || 1));
    target.approval.conditionAcceptedBy = [];
    target.consents = {};
    target.votes = { [target.acquirerId]: {}, [target.targetId]: {} };
    target.readyRound = null;
    target.settlementRound = null;
    target.status = "condition_review";
  }, { mergerId, condition: text, source, conditionData }, [merger.acquirerId, merger.targetId]);
}

export function acceptMergerCondition(state, mergerId, playerId) {
  const merger = state.mergers.find(item => item.id === mergerId);
  if (!merger || merger.approval.outcome !== "approved_with_conditions") throw new Error("No merger condition is awaiting acceptance.");
  if (!merger.approval.condition || merger.approval.condition === "AI condition pending.") throw new Error("The AI condition has not been defined yet.");
  if (![merger.acquirerId, merger.targetId].includes(playerId)) throw new Error("Only the merging companies may accept this condition.");
  return commit(state, "merger_condition_accepted", `${entityName(state, playerId)} accepted the merger condition.`, next => {
    const target = next.mergers.find(item => item.id === mergerId);
    if (!target.approval.conditionAcceptedBy.includes(playerId)) target.approval.conditionAcceptedBy.push(playerId);
    refreshMergerReadiness(next, target);
  }, { mergerId, playerId }, [playerId]);
}

export function signMerger(state, mergerId, playerId) {
  const merger = state.mergers.find(item => item.id === mergerId);
  if (!merger) throw new Error("Merger not found.");
  if (![merger.acquirerId, merger.targetId].includes(playerId)) throw new Error("Only the two merging companies may consent.");
  if (!mergerApprovalSatisfied(merger)) throw new Error("Resolve regulatory approval and conditions before signing.");
  return commit(state, "merger_consent", `${entityName(state, playerId)} consented to “${merger.title}”.`, next => {
    const target = next.mergers.find(item => item.id === mergerId);
    target.consents[playerId] = isoNow();
    refreshMergerReadiness(next, target);
  }, { mergerId, playerId }, [playerId]);
}

export function castMergerVote(state, mergerId, companyId, voterId, vote) {
  if (!["yes", "no"].includes(vote)) throw new Error("Vote must be yes or no.");
  const merger = state.mergers.find(item => item.id === mergerId);
  if (!merger) throw new Error("Merger not found.");
  const snapshot = merger.voteSnapshots[companyId];
  if (!snapshot) throw new Error("This company does not vote on the merger.");
  if (!mergerApprovalSatisfied(merger)) throw new Error("Resolve regulatory approval and conditions before shareholder voting.");
  if (!snapshot.holdings.some(item => item.entityId === voterId && item.shares > 0)) throw new Error("Only record-date shareholders may vote.");
  return commit(state, "merger_vote", `${entityName(state, voterId)} voted ${vote.toUpperCase()} on “${merger.title}” for ${getStock(state, companyId).ticker}.`, next => {
    const target = next.mergers.find(item => item.id === mergerId);
    target.votes[companyId][voterId] = vote;
    refreshMergerReadiness(next, target);
  }, { mergerId, companyId, voterId, vote }, [voterId, companyId]);
}

function replaceEntityId(list, fromId, toId) {
  return [...new Set((list || []).map(id => id === fromId ? toId : id))];
}

export function executeMerger(state, mergerId, rng = Math.random) {
  const merger = state.mergers.find(item => item.id === mergerId);
  if (!merger) throw new Error("Merger not found.");
  if (!mergerApprovalSatisfied(merger) || !mergerVotePassed(merger) || !(merger.consents[merger.acquirerId] && merger.consents[merger.targetId])) throw new Error("The merger lacks final consent, approval, or shareholder votes.");
  if (!merger.settlementRound || state.round < merger.settlementRound) throw new Error(`This merger settles in round ${merger.settlementRound || "—"}.`);
  const conflicting = state.deals.find(deal => !["rejected", "executed", "cancelled"].includes(deal.status) && [deal.proposerId, deal.counterpartyId].some(id => [merger.acquirerId, merger.targetId].includes(id)));
  if (conflicting) throw new Error(`Settle or reject pending deal “${conflicting.title}” before the merger.`);

  let mergedState = commit(state, "merger_executed", `${entityName(state, merger.acquirerId)} acquired ${entityName(state, merger.targetId)} after the two-round settlement lag.`, next => {
    const targetMerger = next.mergers.find(item => item.id === mergerId);
    const acquirer = getPlayer(next, targetMerger.acquirerId);
    const target = getPlayer(next, targetMerger.targetId);
    acquirer.cash = roundMoney(acquirer.cash + target.cash);
    target.cash = 0;
    target.mergedInto = acquirer.id;

    for (const property of next.properties) {
      const targetShare = property.ownerShares.find(share => share.entityId === target.id);
      if (!targetShare) continue;
      const acquirerShare = property.ownerShares.find(share => share.entityId === acquirer.id);
      if (acquirerShare) acquirerShare.percent = round2(acquirerShare.percent + targetShare.percent);
      else property.ownerShares.push({ entityId: acquirer.id, percent: targetShare.percent });
      property.ownerShares = normalizeShares(property.ownerShares.filter(share => share.entityId !== target.id));
    }

    for (const stock of next.market.stocks) {
      if (stock.companyId === target.id) continue;
      const targetHolding = stock.holdings.find(holding => holding.entityId === target.id);
      if (!targetHolding) continue;
      const acquirerHolding = stock.holdings.find(holding => holding.entityId === acquirer.id);
      if (acquirerHolding) acquirerHolding.shares = round2(acquirerHolding.shares + targetHolding.shares);
      else stock.holdings.push({ entityId: acquirer.id, shares: targetHolding.shares });
      stock.holdings = normalizeStockHoldings(stock.holdings.filter(holding => holding.entityId !== target.id));
    }

    const acquirerStock = getStock(next, acquirer.id);
    const targetStock = getStock(next, target.id);
    let newShares = 0;
    for (const holding of targetStock.holdings) {
      const converted = round2(holding.shares * targetMerger.exchangeRatio);
      if (converted <= 0) continue;
      const existing = acquirerStock.holdings.find(item => item.entityId === holding.entityId);
      if (existing) existing.shares = round2(existing.shares + converted);
      else acquirerStock.holdings.push({ entityId: holding.entityId, shares: converted });
      newShares = round2(newShares + converted);
    }
    acquirerStock.outstandingShares = round2(acquirerStock.outstandingShares + newShares);
    if (acquirerStock.authorizedShares < acquirerStock.outstandingShares) acquirerStock.authorizedShares = Math.ceil(acquirerStock.outstandingShares + 25);
    acquirerStock.holdings = normalizeStockHoldings(acquirerStock.holdings);
    targetStock.status = "merged";
    targetStock.mergedInto = acquirerStock.id;

    for (const contract of next.contracts) contract.partyIds = replaceEntityId(contract.partyIds, target.id, acquirer.id);
    for (const loan of next.loans || []) {
      if (loan.borrowerId === target.id) loan.borrowerId = acquirer.id;
      if (loan.lenderId === target.id) loan.lenderId = acquirer.id;
    }
    for (const policy of next.policies || []) {
      if (policy.companyId === target.id && !["active", "rejected", "cancelled"].includes(policy.status)) policy.status = "cancelled";
    }
    targetMerger.status = "executed";
    targetMerger.executedAt = isoNow();
  }, { mergerId, settlementRound: merger.settlementRound, exchangeRatio: merger.exchangeRatio }, [merger.acquirerId, merger.targetId]);
  // The delisted target no longer has a turn; if it was up, play moves on immediately.
  if (mergedState.players[mergedState.activePlayerIndex]?.mergedInto) mergedState = advanceTurn(mergedState, rng);
  const eligibility = antitrustEligibility(mergedState, merger.acquirerId);
  if (eligibility.eligible) mergedState = runAntitrustReview(mergedState, merger.acquirerId, rng);
  return mergedState;
}

export function antitrustEligibility(state, companyId) {
  const company = getPlayer(state, companyId);
  if (company.mergedInto || company.bankrupt) return { eligible: false, reasons: [], alreadyReviewed: false };
  const alreadyReviewed = (state.antitrustReviews || []).some(review => review.companyId === companyId);
  const fullOwner = property => property.ownerShares.length === 1 && property.ownerShares[0].entityId === companyId && Math.abs(property.ownerShares[0].percent - 100) < 0.001;
  const railroadCount = state.properties.filter(property => property.type === "railroad" && fullOwner(property)).length;
  const groups = [...new Set(state.properties.filter(property => property.type === "street").map(property => property.group))];
  const completeGroups = groups.filter(group => {
    const properties = state.properties.filter(property => property.type === "street" && property.group === group);
    return properties.length === GROUP_SIZES[group] && properties.every(fullOwner);
  });
  const completedMerger = state.mergers.some(merger => merger.status === "executed" && merger.acquirerId === companyId);
  const reasons = [];
  if (completedMerger) reasons.push("completed_merger");
  if (railroadCount === 4) reasons.push("four_railroads");
  if (completeGroups.length >= 3) reasons.push("three_color_groups");
  return { eligible: reasons.length > 0 && !alreadyReviewed, reasons, alreadyReviewed, railroadCount, completeGroups };
}

function eligibleAntitrustProperties(state, companyId) {
  return state.properties.filter(property =>
    property.ownerShares.length === 1
    && property.ownerShares[0].entityId === companyId
    && Math.abs(property.ownerShares[0].percent - 100) < 0.001
    && !property.mortgaged
    && Number(property.buildings || 0) === 0
  ).map(property => property.id);
}

export function runAntitrustReview(state, companyId, rng = Math.random) {
  const eligibility = antitrustEligibility(state, companyId);
  if (eligibility.alreadyReviewed) throw new Error(`${entityName(state, companyId)} has already received its one antitrust review.`);
  if (!eligibility.eligible) throw new Error(`${entityName(state, companyId)} has not triggered antitrust review.`);
  const draw = Math.max(0, Math.min(0.999999, Number(rng())));
  const outcome = draw < 0.20 ? "cleared"
    : draw < 0.40 ? "fine_200"
      : draw < 0.60 ? "half_rent"
        : draw < 0.80 ? "construction_freeze"
          : "divestiture";
  const eligiblePropertyIds = outcome === "divestiture" ? eligibleAntitrustProperties(state, companyId) : [];
  const fallbackFine = outcome === "divestiture" && eligiblePropertyIds.length === 0;
  const description = {
    cleared: "was cleared in antitrust review",
    fine_200: "received a $200 antitrust fine",
    half_rent: "must collect only half rent through the next full round",
    construction_freeze: "cannot buy houses or hotels through the next full round",
    divestiture: fallbackFine ? "had no eligible divestiture property and received a $150 fine" : "must sell one eligible unimproved property at a table auction"
  }[outcome];
  return commit(state, "antitrust_review", `${entityName(state, companyId)} ${description}.`, next => {
    const company = getPlayer(next, companyId);
    const fineAmount = outcome === "fine_200" ? 200 : fallbackFine ? 150 : 0;
    const finePaid = fineAmount > 0 && company.cash >= fineAmount;
    if (finePaid) chargeFee(next, companyId, fineAmount, outcome === "fine_200" ? "Antitrust fine" : "Antitrust no-property fallback fine");
    if (outcome === "half_rent") company.antitrustHalfRentUntilRound = next.round + 1;
    if (outcome === "construction_freeze") company.constructionFreezeUntilRound = next.round + 1;
    next.antitrustReviews.unshift({
      id: uid("antitrust"), companyId, createdRound: next.round, reasons: clone(eligibility.reasons), outcome,
      status: outcome === "divestiture" && !fallbackFine ? "divestiture_due" : fineAmount > 0 && !finePaid ? "fine_due" : "resolved",
      eligiblePropertyIds: clone(eligiblePropertyIds), fallbackFine, fineAmount, finePaid,
      resolvedAt: outcome === "divestiture" && !fallbackFine || fineAmount > 0 && !finePaid ? null : isoNow()
    });
  }, { companyId, reasons: eligibility.reasons, outcome, eligiblePropertyIds, fallbackFine }, [companyId]);
}

export function payAntitrustFine(state, reviewId) {
  const review = state.antitrustReviews.find(item => item.id === reviewId);
  if (!review || review.status !== "fine_due" || !Number(review.fineAmount)) throw new Error("No antitrust fine is awaiting payment.");
  return commit(state, "antitrust_fine_paid", `${entityName(state, review.companyId)} paid the $${Number(review.fineAmount)} antitrust fine into Free Parking.`, next => {
    chargeFee(next, review.companyId, review.fineAmount, "Antitrust fine");
    const target = next.antitrustReviews.find(item => item.id === reviewId);
    target.status = "resolved";
    target.finePaid = true;
    target.resolvedAt = isoNow();
  }, { reviewId, companyId: review.companyId, amount: review.fineAmount }, [review.companyId]);
}

export function completeAntitrustDivestiture(state, reviewId, propertyId, buyerId, price) {
  const review = state.antitrustReviews.find(item => item.id === reviewId);
  if (!review || review.status !== "divestiture_due") throw new Error("No antitrust property sale is awaiting completion.");
  if (!review.eligiblePropertyIds.includes(propertyId)) throw new Error("That property was not eligible for this antitrust sale.");
  if (buyerId === review.companyId) throw new Error("The divesting company cannot buy its own forced-sale property.");
  const buyer = getPlayer(state, buyerId);
  if (buyer.bankrupt || buyer.mergedInto) throw new Error("Choose an active independent buyer.");
  const amount = roundMoney(price);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter the winning auction price.");
  const property = state.properties.find(item => item.id === propertyId);
  if (!property || property.mortgaged || property.buildings || property.ownerShares.length !== 1 || property.ownerShares[0].entityId !== review.companyId) throw new Error("The selected property is no longer eligible for divestiture.");
  return commit(state, "antitrust_divestiture", `${entityName(state, buyerId)} bought ${property.name} from ${entityName(state, review.companyId)} for $${amount} in the antitrust auction.`, next => {
    adjustCash(next, buyerId, -amount);
    adjustCash(next, review.companyId, amount);
    const targetProperty = next.properties.find(item => item.id === propertyId);
    targetProperty.ownerShares = [{ entityId: buyerId, percent: 100 }];
    const targetReview = next.antitrustReviews.find(item => item.id === reviewId);
    targetReview.status = "resolved";
    targetReview.selectedPropertyId = propertyId;
    targetReview.buyerId = buyerId;
    targetReview.salePrice = amount;
    targetReview.resolvedAt = isoNow();
  }, { reviewId, companyId: review.companyId, propertyId, buyerId, price: amount }, [review.companyId, buyerId]);
}

export function propertyTaxableValue(state, playerId) {
  let total = 0;
  for (const property of state.properties) {
    const share = property.ownerShares.find(item => item.entityId === playerId);
    if (!share) continue;
    const base = property.mortgaged ? property.price * 0.5 : property.price;
    const improvements = property.buildings * property.buildCost;
    total += (base + improvements) * share.percent / 100;
  }
  return roundMoney(total);
}

export function calculateTaxBill(state, playerId) {
  const taxableProperty = propertyTaxableValue(state, playerId);
  const propertyTax = taxableProperty > 0 ? Math.max(10, Math.round((taxableProperty * 0.03) / 10) * 10) : 0;
  const netWorth = playerNetWorth(state, playerId);
  const incomeTax = netWorth >= 5000 ? 250 : netWorth >= 4000 ? 175 : netWorth >= 3000 ? 100 : netWorth >= 2000 ? 50 : 0;
  return { taxableProperty: roundMoney(taxableProperty), propertyTax: roundMoney(propertyTax), netWorth: roundMoney(netWorth), incomeTax: roundMoney(incomeTax), total: roundMoney(propertyTax + incomeTax) };
}

export function createTaxBillsForRound(state) {
  const interval = Number(state.settings.taxIntervalRounds ?? GAME_DEFAULTS.taxIntervalRounds);
  if (!interval || state.round % interval !== 0) return state;
  if (state.taxBills.some(bill => bill.round === state.round)) return state;
  return commit(state, "tax_day", `Tax Day bills were issued for round ${state.round}.`, next => {
    for (const player of next.players.filter(item => !item.bankrupt && !item.mergedInto)) {
      const calculation = calculateTaxBill(next, player.id);
      next.taxBills.unshift({ id: uid("tax"), playerId: player.id, round: next.round, ...calculation, status: calculation.total > 0 ? "due" : "paid", paidAt: calculation.total > 0 ? null : isoNow() });
    }
  }, { round: state.round });
}

export function payTaxBill(state, taxBillId) {
  const bill = state.taxBills.find(item => item.id === taxBillId);
  if (!bill) throw new Error("Tax bill not found.");
  if (bill.status === "paid") throw new Error("This tax bill is already paid.");
  return commit(state, "tax_paid", `${entityName(state, bill.playerId)} paid $${bill.total} in property and net-worth taxes into Free Parking.`, next => {
    adjustCash(next, bill.playerId, -bill.total);
    adjustCash(next, feeDestination(next), bill.total);
    const target = next.taxBills.find(item => item.id === taxBillId);
    target.status = "paid";
    target.paidAt = isoNow();
  }, { taxBillId, propertyTax: bill.propertyTax, incomeTax: bill.incomeTax, total: bill.total }, [bill.playerId]);
}

export function collectFreeParking(state, playerId) {
  if (!state.settings.freeParkingJackpot) throw new Error("The Free Parking jackpot is disabled.");
  const amount = roundMoney(state.freeParkingPot);
  if (amount <= 0) throw new Error("The Free Parking pot is empty.");
  return commit(state, "free_parking_collected", `${entityName(state, playerId)} collected the $${amount} Free Parking jackpot.`, next => {
    adjustCash(next, POT, -amount);
    adjustCash(next, playerId, amount);
  }, { playerId, amount }, [playerId]);
}


export function createDispute(state, input) {
  const dispute = {
    id: uid("dispute"),
    title: String(input.title || "Rule dispute").trim(),
    claimantId: input.claimantId || null,
    respondentId: input.respondentId || null,
    linkedContractId: input.linkedContractId || null,
    issue: String(input.issue || "").trim(),
    evidence: String(input.evidence || "").trim(),
    requestedRemedy: String(input.requestedRemedy || "").trim(),
    status: "open",
    createdAt: isoNow(),
    createdRound: state.round,
    appealOf: input.appealOf || null
  };
  if (!dispute.issue) throw new Error("Describe the issue to be judged.");
  for (const partyId of [dispute.claimantId, dispute.respondentId]) if (partyId) getPlayer(state, partyId);
  if (dispute.linkedContractId && !state.contracts.some(contract => contract.id === dispute.linkedContractId)) throw new Error("Linked contract not found.");
  return commit(state, "dispute_created", `Opened dispute “${dispute.title}”.`, next => next.disputes.unshift(dispute), { disputeId: dispute.id }, [dispute.claimantId, dispute.respondentId].filter(Boolean));
}

export function localRuleTest(state, disputeId) {
  const dispute = state.disputes.find(d => d.id === disputeId);
  if (!dispute) throw new Error("Dispute not found.");
  const contract = dispute.linkedContractId ? state.contracts.find(c => c.id === dispute.linkedContractId) : null;
  const haystack = `${dispute.issue} ${dispute.evidence} ${contract?.terms || ""}`.toLowerCase();
  const cited = new Set(["R-00", "R-02", "R-21"]);
  const keywordMap = [
    [["deal", "accepted", "signed", "signature", "contract"], ["R-03", "R-07"]],
    [["future", "promise", "later", "expires", "settlement", "delay"], ["R-07"]],
    [["secret", "verbal", "unrecorded"], ["R-03"]],
    [["rent", "discount", "dividend", "revenue share"], ["R-12"]],
    [["loan", "interest", "collateral", "default", "rate", "liquidity", "bank cash"], ["R-26", "R-28"]],
    [["merger", "acquirer", "target", "exchange ratio"], ["R-15", "R-16"]],
    [["share", "stock", "corporation", "capital", "vote", "dilution"], ["R-09", "R-10", "R-11", "R-12", "R-13"]],
    [["mortgage", "house", "hotel", "building", "property"], ["R-17", "R-27"]],
    [["auction", "bid", "antitrust"], ["R-20"]],
    [["random", "approval", "committee", "condition", "rejected"], ["R-05", "R-06"]],
    [["tax", "net worth", "property tax"], ["R-18", "R-19"]],
    [["rounding", "cents", "whole dollar", "denomination"], ["R-27"]],
    [["voice", "speech", "transcription", "microphone"], ["R-23"]]
  ];
  for (const [keywords, ids] of keywordMap) if (keywords.some(k => haystack.includes(k))) ids.forEach(id => cited.add(id));

  let verdict = "needs_table_review";
  let confidence = 0.45;
  let summary = "The local rule test identified relevant provisions but cannot reliably resolve contested facts.";
  if (contract && !Object.keys(contract.signatures || {}).length && contract.status === "draft") {
    verdict = "not_binding";
    confidence = 0.9;
    summary = "The linked contract is still a draft and has no recorded signatures, so it is not binding under R-03.";
    cited.add("R-03");
  } else if (haystack.includes("secret") || haystack.includes("unrecorded verbal")) {
    verdict = "unenforceable_unrecorded_term";
    confidence = 0.82;
    summary = "A secret or unrecorded term cannot be enforced by the judge under R-03.";
    cited.add("R-03");
  }
  return {
    verdict,
    confidence,
    citedRuleIds: [...cited],
    findings: [summary],
    orders: verdict === "needs_table_review" ? ["Collect or clarify the missing evidence before transferring assets."] : ["Apply the cited rule unless an appeal changes the result."],
    explanation: summary,
    ambiguities: verdict === "needs_table_review" ? ["The local test does not determine witness credibility or infer missing contract terms."] : [],
    suggestedVote: verdict === "needs_table_review" ? "Neutral table vote" : "No vote required unless appealed",
    model: "local-deterministic-rule-test",
    mode: "local",
    generatedAt: isoNow()
  };
}

export function recordJudgement(state, disputeId, judgement) {
  const dispute = state.disputes.find(d => d.id === disputeId);
  if (!dispute) throw new Error("Dispute not found.");
  const record = {
    id: uid("judgement"),
    disputeId,
    verdict: judgement.verdict || "insufficient_evidence",
    confidence: Number(judgement.confidence ?? 0),
    citedRuleIds: clone(judgement.citedRuleIds || judgement.cited_rule_ids || []),
    findings: clone(judgement.findings || []),
    orders: clone(judgement.orders || []),
    explanation: judgement.explanation || judgement.reasoning_summary || "",
    ambiguities: clone(judgement.ambiguities || []),
    suggestedVote: judgement.suggestedVote || judgement.suggested_vote || "",
    model: judgement.model || "unknown",
    mode: judgement.mode || "ai",
    evidenceSnapshot: judgement.evidenceSnapshot || null,
    createdAt: isoNow(),
    appealStatus: "not_appealed",
    tableOverride: null
  };
  return commit(state, "judgement_recorded", `Judge ruled “${record.verdict}” in “${dispute.title}”.`, next => {
    next.judgements.unshift(record);
    next.disputes.find(d => d.id === disputeId).status = "ruled";
  }, { disputeId, judgementId: record.id, model: record.model, verdict: record.verdict }, [dispute.claimantId, dispute.respondentId].filter(Boolean));
}

export function overrideJudgement(state, judgementId, outcome, notes) {
  const judgement = state.judgements.find(j => j.id === judgementId);
  if (!judgement) throw new Error("Judgement not found.");
  return commit(state, "judgement_override", `Table marked judgement ${outcome}.`, next => {
    const target = next.judgements.find(j => j.id === judgementId);
    target.tableOverride = { outcome, notes: String(notes || ""), at: isoNow() };
  }, { judgementId, outcome, notes });
}

export function buildJudgePacket(state, disputeId) {
  const dispute = state.disputes.find(d => d.id === disputeId);
  if (!dispute) throw new Error("Dispute not found.");
  const linkedContract = dispute.linkedContractId ? state.contracts.find(c => c.id === dispute.linkedContractId) : null;
  return {
    game: { id: state.id, name: state.name, round: state.round, rulebookVersion: state.rulebookVersion, judgeMode: state.settings.judgeMode },
    dispute: clone(dispute),
    linkedContract: clone(linkedContract),
    players: state.players.map(({ id, name, cash, bankrupt }) => ({ id, name, cash, bankrupt })),
    properties: state.properties.filter(p => p.ownerShares.length).map(({ id, name, ownerShares, mortgaged, buildings }) => ({ id, name, ownerShares, mortgaged, buildings })),
    stocks: state.market.stocks.map(({ companyId, ticker, status, price, outstandingShares, holdings }) => ({ companyId, ticker, status, price, outstandingShares, holdings })),
    policies: state.policies.filter(policy => policy.status === "active" || policy.status === "pending_effective_date"),
    mergers: state.mergers,
    antitrustReviews: state.antitrustReviews,
    taxBills: state.taxBills.filter(bill => bill.status === "due"),
    relevantLedger: state.ledger.slice(0, 100),
    priorJudgements: state.judgements.filter(j => j.disputeId === disputeId),
    rules: RULES
  };
}

export function playerNetWorthBreakdown(state, playerId) {
  const player = getPlayer(state, playerId);
  const breakdown = {
    cash: roundMoney(player.cash),
    propertyEquity: 0,
    stockInvestments: 0,
    receivables: 0,
    debts: 0,
    total: 0
  };
  for (const property of state.properties) {
    const share = property.ownerShares.find(s => s.entityId === playerId);
    if (!share) continue;
    const propertyValue = property.mortgaged ? property.price * 0.5 : property.price;
    breakdown.propertyEquity += (propertyValue + property.buildings * property.buildCost) * share.percent / 100;
  }
  for (const stock of state.market?.stocks || []) {
    if (stock.companyId === playerId || stock.status !== "active") continue;
    const shares = stockHolding(stock, playerId);
    breakdown.stockInvestments += shares * stock.price;
  }
  for (const loan of state.loans || []) {
    if (!["active", "delinquent"].includes(loan.status)) continue;
    if (loan.lenderId === playerId) breakdown.receivables += loan.balance;
    if (loan.borrowerId === playerId) breakdown.debts += loan.balance;
  }
  breakdown.propertyEquity = roundMoney(breakdown.propertyEquity);
  breakdown.stockInvestments = roundMoney(breakdown.stockInvestments);
  breakdown.receivables = roundMoney(breakdown.receivables);
  breakdown.debts = roundMoney(breakdown.debts);
  breakdown.total = roundMoney(breakdown.cash + breakdown.propertyEquity + breakdown.stockInvestments + breakdown.receivables - breakdown.debts);
  return breakdown;
}

export function playerNetWorth(state, playerId) {
  return playerNetWorthBreakdown(state, playerId).total;
}

function defaultMarketForPlayers(players) {
  return {
    lastUpdatedRound: 1,
    stocks: players.map((player, index) => ({
      id: `STOCK_${player.id}`,
      companyId: player.id,
      name: player.companyName || `${player.name} Holdings`,
      ticker: player.ticker || makeTicker(player.name, index),
      status: "active",
      mergedInto: null,
      price: GAME_DEFAULTS.stockInitialPrice,
      previousPrice: GAME_DEFAULTS.stockInitialPrice,
      lastChangePercent: 0,
      authorizedShares: GAME_DEFAULTS.stockAuthorizedShares,
      outstandingShares: GAME_DEFAULTS.stockInitialShares,
      holdings: [{ entityId: player.id, shares: GAME_DEFAULTS.stockInitialShares }],
      history: [{ round: 1, price: GAME_DEFAULTS.stockInitialPrice, changePercent: 0 }]
    }))
  };
}

function defaultBankState(players = [], options = {}) {
  const startingCash = roundMoney(options.startingCash ?? 1500);
  const initialCash = roundMoney(options.bankStartingCash ?? Math.max(5000, GAME_DEFAULTS.totalBankCash - players.length * startingCash));
  const ratePercent = roundRate(options.initialRatePercent ?? GAME_DEFAULTS.bankRateAtFullLiquidityPercent);
  return {
    cash: initialCash,
    initialCash,
    reserveFloor: roundMoney(options.reserveFloor ?? GAME_DEFAULTS.bankReserveFloor),
    emergencyCredit: 0,
    lending: {
      currentRatePercent: ratePercent,
      baseRatePercent: ratePercent,
      randomSpreadPercent: 0,
      lastUpdatedRound: 1,
      history: [{ round: 1, cash: initialCash, liquidityRatio: 1, baseRatePercent: ratePercent, randomSpreadPercent: 0, ratePercent }]
    }
  };
}

function migrateState(state) {
  state.schemaVersion = 4;
  state.organizations ||= [];
  state.deals ||= [];
  state.contracts ||= [];
  state.loans ||= [];
  state.policies ||= [];
  state.mergers ||= [];
  state.antitrustReviews ||= [];
  state.taxBills ||= [];
  state.disputes ||= [];
  state.judgements ||= [];
  state.ledger ||= [];
  state.undoStack ||= [];
  state.settings ||= {};
  Object.assign(state.settings, {
    freeParkingJackpot: state.settings.freeParkingJackpot !== false,
    judgeMode: state.settings.judgeMode || "advisory",
    localAutosave: true,
    voiceReadback: state.settings.voiceReadback !== false,
    voicePreferLocal: state.settings.voicePreferLocal !== false,
    voiceLanguage: state.settings.voiceLanguage || "en-US",
    legalFee: roundMoney(state.settings.legalFee ?? GAME_DEFAULTS.legalFee),
    mergerFee: roundMoney(state.settings.mergerFee ?? GAME_DEFAULTS.mergerFee),
    dealSettlementLagRounds: Number(state.settings.dealSettlementLagRounds ?? GAME_DEFAULTS.dealSettlementLagRounds),
    stockDividendRate: Number(state.settings.stockDividendRate ?? GAME_DEFAULTS.stockDividendRate),
    taxIntervalRounds: Number(state.settings.taxIntervalRounds ?? GAME_DEFAULTS.taxIntervalRounds),
    bankLoanMaximum: Number(state.settings.bankLoanMaximum ?? GAME_DEFAULTS.bankLoanMaximum),
    bankLoanMinimum: Number(state.settings.bankLoanMinimum ?? GAME_DEFAULTS.bankLoanMinimum),
    bankLoanTermRounds: Number(state.settings.bankLoanTermRounds ?? GAME_DEFAULTS.bankLoanTermRounds)
  });
  state.players.forEach((player, index) => {
    player.id ||= `P${index + 1}`;
    player.name = String(player.name || `Player ${index + 1}`);
    player.cash = roundMoney(player.cash);
    player.jailFreeCards = Number(player.jailFreeCards || 0);
    player.bankrupt = Boolean(player.bankrupt);
    player.mergedInto ??= null;
    player.antitrustHalfRentUntilRound ??= 0;
    player.constructionFreezeUntilRound ??= 0;
    player.color ||= PLAYER_COLORS[index % PLAYER_COLORS.length];
    player.companyName ||= `${player.name} Holdings`;
    player.ticker ||= makeTicker(player.name, index);
  });
  state.market ||= defaultMarketForPlayers(state.players);
  state.market.lastUpdatedRound ??= state.round || 1;
  state.market.stocks ||= defaultMarketForPlayers(state.players).stocks;
  for (const stock of state.market.stocks) {
    stock.price = roundMoney(stock.price);
    stock.previousPrice = roundMoney(stock.previousPrice ?? stock.price);
    for (const point of stock.history || []) point.price = roundMoney(point.price);
  }
  state.freeParkingPot = roundMoney(state.freeParkingPot || 0);
  state.bank ||= defaultBankState(state.players);
  state.bank.cash = roundMoney(state.bank.cash ?? state.bank.initialCash ?? defaultBankState(state.players).cash);
  state.bank.initialCash = roundMoney(state.bank.initialCash ?? defaultBankState(state.players).initialCash);
  state.bank.reserveFloor = roundMoney(state.bank.reserveFloor ?? GAME_DEFAULTS.bankReserveFloor);
  state.bank.emergencyCredit = roundMoney(state.bank.emergencyCredit || 0);
  state.bank.lending ||= {};
  state.bank.lending.randomSpreadPercent = roundRate(state.bank.lending.randomSpreadPercent || 0);
  state.bank.lending.lastUpdatedRound ??= state.round || 1;
  state.bank.lending.history ||= [];
  refreshBankLendingRate(state);
  if (!state.bank.lending.history.length) {
    state.bank.lending.history.push({ round: state.round || 1, ...bankRateComponents(state) });
  }
  for (const loan of state.loans) {
    loan.lenderId ||= BANK;
    loan.status ||= "active";
    loan.createdRound ??= 1;
    loan.dueRound ??= loan.createdRound + Number(state.settings.bankLoanTermRounds || GAME_DEFAULTS.bankLoanTermRounds);
    loan.ratePercent = roundRate(loan.ratePercent || 0);
    loan.principal = roundMoney(loan.principal || loan.balance || 0);
    loan.interestAmount = roundMoney(loan.interestAmount ?? Math.max(0, Number(loan.balance || 0) - loan.principal));
    loan.balance = roundMoney(loan.balance ?? loan.principal + loan.interestAmount);
    loan.delinquentAt ??= null;
    loan.repaidAt ??= null;
  }
  for (const deal of state.deals) {
    deal.kind ||= "deal";
    deal.createdRound ??= 1;
    deal.legalFee ??= 0;
    deal.signatures ||= {};
    deal.proposerGives ||= [];
    deal.counterpartyGives ||= [];
    deal.extraSettlementRounds ??= 0;
    deal.requiredCompanyVoteIds ||= [];
    deal.voteSnapshots ||= {};
    deal.votes ||= {};
    deal.voteThresholdPercent ??= 50;
    deal.readyRound ??= deal.status === "executed" ? deal.createdRound : null;
    deal.settlementRound ??= deal.status === "executed" ? deal.createdRound : null;
    deal.approval ||= {};
    if (deal.approval.mode === "off" && !deal.approval.outcome) deal.approval.outcome = "approved";
    deal.approval.probabilityRule ||= "10% approved · 40% conditional · 50% rejected";
    deal.approval.conditionAcceptedBy ||= [];
  }
  for (const policy of state.policies) {
    policy.approval ||= {};
    policy.votes ||= {};
    policy.voteThresholdPercent ??= 50;
    policy.extraSettlementRounds ??= 0;
  }
  for (const merger of state.mergers) {
    merger.approval ||= {};
    merger.approval.conditionAcceptedBy ||= [];
    merger.consents ||= {};
    merger.votes ||= { [merger.acquirerId]: {}, [merger.targetId]: {} };
    merger.voteThresholdPercent ??= 50;
    merger.extraSettlementRounds ??= 0;
  }
  return state;
}

function assertGameShape(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Invalid game file: expected a saved game object.");
  if (!Array.isArray(state.players) || state.players.length !== 4) throw new Error("Invalid game state: Boardroom Chaos requires exactly four player records.");
  if (!Array.isArray(state.properties)) throw new Error("Invalid game file: the property register is missing.");
}


export function validateState(state) {
  assertGameShape(state);
  if (!Array.isArray(state.market?.stocks)) throw new Error("Invalid game state: the stock market is missing.");
  const ids = new Set(state.players.map(p => p.id));
  if (ids.size !== state.players.length) throw new Error("Duplicate player IDs.");
  for (const player of state.players) {
    if (!Number.isFinite(player.cash) || player.cash < -0.001 || !Number.isInteger(player.cash)) throw new Error(`Invalid cash balance for ${player.name}.`);
    if (player.mergedInto && !ids.has(player.mergedInto)) throw new Error(`Invalid merger destination for ${player.name}.`);
  }
  if (!state.bankSupply) state.bankSupply = { houses: 32, hotels: 12 };
  if (!Number.isInteger(state.bankSupply.houses) || state.bankSupply.houses < 0 || state.bankSupply.houses > 32) throw new Error("Invalid bank house supply.");
  if (!Number.isInteger(state.bankSupply.hotels) || state.bankSupply.hotels < 0 || state.bankSupply.hotels > 12) throw new Error("Invalid bank hotel supply.");
  if (!state.bank || !Number.isFinite(state.bank.cash) || state.bank.cash < -0.001 || !Number.isInteger(state.bank.cash)) throw new Error("Invalid bank cash balance.");
  if (!Number.isFinite(state.bank.initialCash) || state.bank.initialCash <= 0) throw new Error("Invalid initial bank liquidity.");
  if (!Number.isFinite(state.bank.reserveFloor) || state.bank.reserveFloor < 0 || !Number.isInteger(state.bank.reserveFloor)) throw new Error("Invalid bank reserve floor.");
  if (!Number.isFinite(state.bank.emergencyCredit) || state.bank.emergencyCredit < 0 || !Number.isInteger(state.bank.emergencyCredit)) throw new Error("Invalid bank emergency-liquidity balance.");
  if (!Number.isInteger(state.freeParkingPot) || state.freeParkingPot < 0) throw new Error("Invalid Free Parking balance.");
  const quote = getBankLendingQuote(state);
  if (!Number.isFinite(quote.ratePercent) || quote.ratePercent < GAME_DEFAULTS.bankRateMinimumPercent - 0.001 || quote.ratePercent > GAME_DEFAULTS.bankRateMaximumPercent + 0.001) throw new Error("Invalid bank lending rate.");
  for (const property of state.properties) {
    const total = sharesTotal(property.ownerShares || []);
    if (total < -0.001 || total > 100.001) throw new Error(`Ownership of ${property.name} totals ${total}%.`);
    for (const share of property.ownerShares || []) {
      if (!ids.has(share.entityId) && !(state.organizations || []).some(o => o.id === share.entityId)) throw new Error(`Unknown owner on ${property.name}.`);
      if (share.percent <= 0) throw new Error(`Invalid ownership share on ${property.name}.`);
    }
  }
  for (const stock of state.market.stocks) {
    if (!ids.has(stock.companyId)) throw new Error(`Unknown listed company ${stock.ticker}.`);
    if (!Number.isFinite(stock.price) || stock.price < 1 || !Number.isInteger(stock.price)) throw new Error(`Invalid market price for ${stock.ticker}.`);
    const held = round2(stock.holdings.reduce((sum, item) => sum + Number(item.shares || 0), 0));
    if (Math.abs(held - stock.outstandingShares) > 0.01) throw new Error(`${stock.ticker} holdings do not equal shares outstanding.`);
    if (stock.authorizedShares + 0.001 < stock.outstandingShares) throw new Error(`${stock.ticker} exceeds authorized shares.`);
    for (const holding of stock.holdings) if (!ids.has(holding.entityId)) throw new Error(`Unknown shareholder in ${stock.ticker}.`);
  }
  for (const loan of state.loans || []) {
    if (loan.lenderId !== BANK && !ids.has(loan.lenderId)) throw new Error("Unknown loan lender.");
    if (!ids.has(loan.borrowerId)) throw new Error("Unknown loan borrower.");
    if (!Number.isFinite(loan.principal) || loan.principal <= 0 || !Number.isInteger(loan.principal)) throw new Error("Invalid loan principal.");
    if (!Number.isFinite(loan.balance) || loan.balance < 0 || !Number.isInteger(loan.balance)) throw new Error("Invalid loan balance.");
    if (!Number.isFinite(loan.ratePercent) || loan.ratePercent < 0) throw new Error("Invalid loan rate.");
    if (!Number.isInteger(Number(loan.dueRound)) || Number(loan.dueRound) < Number(loan.createdRound)) throw new Error("Invalid loan due round.");
    if (!["active", "delinquent", "repaid", "defaulted", "cancelled"].includes(loan.status)) throw new Error("Invalid loan status.");
  }
  return true;
}

export function exportGame(state) {
  validateState(state);
  return JSON.stringify({ ...state, undoStack: [] }, null, 2);
}

export function importGame(json) {
  let state;
  try {
    state = typeof json === "string" ? JSON.parse(json) : clone(json);
  } catch {
    throw new Error("Invalid game file: the JSON could not be parsed.");
  }
  assertGameShape(state);
  state.undoStack = [];
  migrateState(state);
  validateState(state);
  return state;
}
