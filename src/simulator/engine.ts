import type {
  SimulatorDataSource,
  SimulatorInput,
  SimulatorResult,
  CostRange,
  EndpointSimResult,
  ProviderSimResult,
} from "./types";
import { UNCERTAINTY_FACTOR } from "./types";

function makeCostRange(mid: number): CostRange {
  return {
    low: mid * (1 - UNCERTAINTY_FACTOR),
    mid,
    high: mid * (1 + UNCERTAINTY_FACTOR),
  };
}

function addRanges(a: CostRange, b: CostRange): CostRange {
  return { low: a.low + b.low, mid: a.mid + b.mid, high: a.high + b.high };
}

function zeroRange(): CostRange {
  return { low: 0, mid: 0, high: 0 };
}

/** Resolve effective total daily calls from input */
function resolveTotalCalls(input: SimulatorInput): number {
  if (input.mode === "user-centric") {
    const dau = input.dau ?? 0;
    const freq = input.callsPerUserPerDay ?? 1;
    return dau * freq;
  }
  return input.totalCallsPerDay ?? 0;
}

export function runSimulation(
  dataSource: SimulatorDataSource,
  input: SimulatorInput
): SimulatorResult {
  const endpoints = dataSource.getEndpoints();
  const totalCalls = resolveTotalCalls(input);

  // Baseline total calls per day across all endpoints (for distributing scale)
  const baselineTotal = endpoints.reduce(
    (sum, ep) => sum + ep.baseCallsPerDay,
    0
  );

  const endpointResults: EndpointSimResult[] = endpoints.map((ep) => {
    // Each endpoint gets a proportional share of the total simulated volume
    const baseShare =
      baselineTotal > 0 ? ep.baseCallsPerDay / baselineTotal : 0;
    let scaledCalls = totalCalls * baseShare;

    // Apply per-endpoint frequency override (multiplier on top of distribution)
    const override = input.frequencyOverrides?.[ep.id];
    if (override !== undefined && override >= 0) {
      scaledCalls = scaledCalls * override;
    }

    const dailyCostMid = scaledCalls * ep.perCallCost;
    const monthlyMid = dailyCostMid * 30;

    return {
      endpointId: ep.id,
      provider: ep.provider,
      method: ep.method,
      url: ep.url,
      scaledCallsPerDay: scaledCalls,
      dailyCost: makeCostRange(dailyCostMid),
      monthlyCost: makeCostRange(monthlyMid),
      percentOfTotal: 0, // filled in after totals are computed
    };
  });

  // Compute totals
  const totalDailyCost = endpointResults.reduce(
    (sum, ep) => addRanges(sum, ep.dailyCost),
    zeroRange()
  );
  const totalMonthlyCost = endpointResults.reduce(
    (sum, ep) => addRanges(sum, ep.monthlyCost),
    zeroRange()
  );

  // Assign percentages
  for (const ep of endpointResults) {
    ep.percentOfTotal =
      totalMonthlyCost.mid > 0
        ? (ep.monthlyCost.mid / totalMonthlyCost.mid) * 100
        : 0;
  }

  // Group by provider
  const providerMap = new Map<string, EndpointSimResult[]>();
  for (const ep of endpointResults) {
    const existing = providerMap.get(ep.provider) ?? [];
    existing.push(ep);
    providerMap.set(ep.provider, existing);
  }

  const byProvider: ProviderSimResult[] = [];
  for (const [provider, eps] of providerMap.entries()) {
    const providerDaily = eps.reduce(
      (sum, ep) => addRanges(sum, ep.dailyCost),
      zeroRange()
    );
    const providerMonthly = eps.reduce(
      (sum, ep) => addRanges(sum, ep.monthlyCost),
      zeroRange()
    );
    byProvider.push({
      provider,
      endpoints: eps,
      dailyCost: providerDaily,
      monthlyCost: providerMonthly,
      percentOfTotal:
        totalMonthlyCost.mid > 0
          ? (providerMonthly.mid / totalMonthlyCost.mid) * 100
          : 0,
    });
  }

  // Sort providers by monthly cost descending
  byProvider.sort((a, b) => b.monthlyCost.mid - a.monthlyCost.mid);

  return {
    input,
    totalDailyCost,
    totalMonthlyCost,
    byProvider,
    confidence: "low",
    computedAt: new Date().toISOString(),
  };
}

/** Convert user-centric input to volume-centric */
export function userCentricToVolume(
  dau: number,
  callsPerUser: number
): number {
  return dau * callsPerUser;
}

/** Convert volume-centric input to user-centric calls-per-user (requires DAU) */
export function volumeToCallsPerUser(
  totalCalls: number,
  dau: number
): number {
  return dau > 0 ? totalCalls / dau : 1;
}
