import type { EndpointRecord } from "../analysis/types";
import type { EndpointSnapshot, SimulatorDataSource } from "./types";

/**
 * Adapts the static scan EndpointRecord[] to the SimulatorDataSource interface.
 * Derives perCallCost from the pre-calculated monthlyCost and callsPerDay.
 */
export class StaticDataSource implements SimulatorDataSource {
  constructor(private readonly endpoints: EndpointRecord[]) {}

  getEndpoints(): EndpointSnapshot[] {
    return this.endpoints.map((ep) => {
      // Derive per-call cost from monthly cost and daily calls
      // monthlyCost = callsPerDay * 30 * perCallCost
      const dailyCalls = ep.callsPerDay > 0 ? ep.callsPerDay : 1;
      const perCallCost = ep.monthlyCost / (dailyCalls * 30);

      return {
        id: ep.id,
        provider: ep.provider,
        method: ep.method,
        url: ep.url,
        baseCallsPerDay: dailyCalls,
        perCallCost: isFinite(perCallCost) && perCallCost > 0 ? perCallCost : 0,
      };
    });
  }
}
