import * as vscode from "vscode";
import type { HostMessage } from "../messages";
import type { EndpointRecord } from "../analysis/types";
import type { SavedScenario, SimulatorInput } from "../simulator/types";
import { runSimulation, StaticDataSource } from "../simulator";

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
}
