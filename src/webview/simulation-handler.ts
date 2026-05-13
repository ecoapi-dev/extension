import * as vscode from "vscode";
import type { HostMessage } from "../messages";
import type { EndpointRecord } from "../analysis/types";
import type { SavedScenario, SimulatorInput } from "../simulator/types";
import { runSimulation, StaticDataSource } from "../simulator";
import { getOutputChannel } from "../output";

export interface SimulationHandlerContext {
  postMessage(message: HostMessage): void;
  context: vscode.ExtensionContext;
  getLastEndpoints(): EndpointRecord[];
}

export class SimulationHandler {
  private static readonly SCENARIOS_STORAGE_KEY = "recost.simulatorScenarios";

  private savedScenarios: SavedScenario[] = [];
  private scenarioPersistQueue: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: SimulationHandlerContext) {
    this.savedScenarios =
      this.ctx.context.globalState.get<SavedScenario[]>(
        SimulationHandler.SCENARIOS_STORAGE_KEY
      ) ?? [];
  }

  public handleRunSimulation(input: SimulatorInput): void {
    try {
      const endpoints = this.ctx.getLastEndpoints();
      if (endpoints.length === 0) {
        this.ctx.postMessage({ type: "simulationError", message: "Run a scan first to use the simulator." });
        return;
      }
      const source = new StaticDataSource(endpoints);
      const result = runSimulation(source, input);
      this.ctx.postMessage({ type: "simulationResult", result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Simulation failed";
      this.ctx.postMessage({ type: "simulationError", message });
    }
  }

  public async persistScenarios(next: SavedScenario[]): Promise<void> {
    this.scenarioPersistQueue = this.scenarioPersistQueue
      .catch(() => {})
      .then(async () => {
        await this.ctx.context.globalState.update(SimulationHandler.SCENARIOS_STORAGE_KEY, next);
        this.savedScenarios = next;
      });
    await this.scenarioPersistQueue;
  }

  public getSavedScenarios(): SavedScenario[] {
    return this.savedScenarios;
  }

  public async pruneAgainst(currentEndpoints: EndpointRecord[]): Promise<void> {
    if (this.savedScenarios.length === 0) return;
    // Empty endpoint list means the scan returned nothing — likely a misconfigured
    // workspace, all-internal scope, or empty glob. Don't wipe saved scenarios just
    // because the current scan was barren; wait for a real comparison.
    if (currentEndpoints.length === 0) return;
    const currentIds = new Set(currentEndpoints.map((e) => e.id));
    const compatible: SavedScenario[] = [];
    let droppedCount = 0;
    for (const scenario of this.savedScenarios) {
      const referenced = new Set<string>();
      if (scenario.input.frequencyOverrides) {
        for (const id of Object.keys(scenario.input.frequencyOverrides)) referenced.add(id);
      }
      for (const provider of scenario.result.byProvider) {
        for (const endpoint of provider.endpoints) referenced.add(endpoint.endpointId);
      }
      const allValid = [...referenced].every((id) => currentIds.has(id));
      if (allValid) {
        compatible.push(scenario);
      } else {
        droppedCount += 1;
        getOutputChannel().appendLine(
          `[recost] Dropping saved scenario "${scenario.label}" — references endpoint IDs no longer present in the current scan.`
        );
      }
    }
    if (droppedCount > 0) {
      await this.persistScenarios(compatible);
    }
  }
}
