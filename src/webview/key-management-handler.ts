import * as vscode from "vscode";
import type { HostMessage, KeyServiceId, KeyStatusSummary } from "../messages";
import {
  buildKeyFingerprint,
  buildKeyStatusSummary,
  getKeyService,
  listKeyServices,
  maskKeyPreview,
  readStoredSecret,
  resolveCurrentKeyValue,
  validateServiceKey,
  type PersistedKeyValidationSnapshot,
} from "../key-management";

export interface KeyManagementHandlerContext {
  postMessage(message: HostMessage): void;
  context: vscode.ExtensionContext;
  outputChannel: vscode.OutputChannel;
  // For UI navigation only:
  openKeys(focusServiceId?: KeyServiceId): void;
  // Project-id coupling: setServiceKey/clearServiceKey must trigger project-id
  // revalidation when the recost key changes. The provider continues to own
  // the project-id family (separate storage keys + workspaceState).
  getManualProjectId(): string | null;
  clearProjectIdValidationState(): Promise<void>;
  sendProjectIdStatus(): Promise<void>;
  validateManualProjectId(): Promise<void>;
}

export class KeyManagementHandler {
  private static readonly KEY_VALIDATION_STATE_STORAGE_KEY = "recost.keyValidationState";

  private readonly keyValidationState = new Map<KeyServiceId, PersistedKeyValidationSnapshot>();

  constructor(private readonly ctx: KeyManagementHandlerContext) {
    this.restoreKeyValidationState();
  }

  private get context(): vscode.ExtensionContext {
    return this.ctx.context;
  }

  private postMessage(message: HostMessage): void {
    this.ctx.postMessage(message);
  }

  public getKeyServiceIdForProvider(providerId: string): KeyServiceId | undefined {
    return listKeyServices().find((service) => service.providerId === providerId)?.serviceId;
  }

  public async getStoredProviderApiKey(providerId: string): Promise<string | undefined> {
    const serviceId = this.getKeyServiceIdForProvider(providerId);
    if (!serviceId) return undefined;
    return readStoredSecret(getKeyService(serviceId), this.context.secrets);
  }

  public async buildAllKeyStatuses(): Promise<KeyStatusSummary[]> {
    const services = listKeyServices();
    return Promise.all(
      services.map((service) =>
        this.buildKeyStatus(service)
      )
    );
  }

  public async sendAllKeyStatuses(focusServiceId?: KeyServiceId) {
    this.postMessage({ type: "allKeyStatuses", statuses: await this.buildAllKeyStatuses(), focusServiceId });
  }

  public async sendKeyStatusUpdate(serviceId: KeyServiceId, focusServiceId?: KeyServiceId) {
    const service = getKeyService(serviceId);
    const status = await this.buildKeyStatus(service);
    this.postMessage({ type: "keyStatusUpdated", status, focusServiceId });
  }

  public async clearServiceKey(serviceId: KeyServiceId) {
    const service = getKeyService(serviceId);
    if (service.secretStorageKey) {
      await this.context.secrets.delete(service.secretStorageKey);
    }
    if (serviceId === "openai") {
      await this.context.secrets.delete("recost.openaiApiKey");
    }
    await this.clearValidationState(serviceId);
    await this.sendKeyStatusUpdate(serviceId);
    if (serviceId === "recost") {
      await this.ctx.clearProjectIdValidationState();
      await this.ctx.sendProjectIdStatus();
    }
  }

  public async setServiceKey(serviceId: KeyServiceId, value: string) {
    const service = getKeyService(serviceId);
    const trimmed = value.trim();
    if (!trimmed) {
      this.postMessage({ type: "keyActionError", serviceId, message: "API key must not be empty." });
      return;
    }
    if (!service.secretStorageKey) {
      this.postMessage({ type: "keyActionError", serviceId, message: `${service.displayName} does not use stored API keys in this extension.` });
      return;
    }
    if (serviceId === "openai" && !/^sk-/.test(trimmed)) {
      this.postMessage({ type: "keyActionError", serviceId, message: 'OpenAI API keys must start with "sk-".' });
      return;
    }
    await this.context.secrets.store(service.secretStorageKey, trimmed);
    if (serviceId === "openai") {
      await this.context.secrets.store("recost.openaiApiKey", trimmed);
    }
    await this.clearValidationState(serviceId);
    await this.sendKeyStatusUpdate(serviceId);
    await this.testServiceKey(serviceId);
    if (serviceId === "recost" && this.ctx.getManualProjectId()) {
      await this.ctx.validateManualProjectId();
    }
  }

  public async testServiceKey(serviceId: KeyServiceId) {
    const service = getKeyService(serviceId);
    const current = await this.buildKeyStatus(service);
    if (current.source === "missing") {
      this.postMessage({ type: "keyActionError", serviceId, message: `${service.displayName} key is missing.` });
      return;
    }
    this.postMessage({
      type: "keyStatusUpdated",
      status: { ...current, state: "checking", message: undefined },
      focusServiceId: serviceId,
    });
    try {
      const value = await resolveCurrentKeyValue(service, this.context.secrets);
      if (!value) {
        this.postMessage({ type: "keyActionError", serviceId, message: `${service.displayName} key is missing.` });
        return;
      }
      const validation = await validateServiceKey(service, value);
      await this.setValidationState(serviceId, {
        ...validation,
        keyFingerprint: buildKeyFingerprint(value),
      });
      await this.sendKeyStatusUpdate(serviceId, serviceId);
      if (serviceId === "recost") {
        await vscode.commands.executeCommand("setContext", "recost.keyOnline", validation.state === "valid");
      }
    } catch (error) {
      const previous = this.keyValidationState.get(serviceId);
      await this.sendKeyStatusUpdate(serviceId, serviceId);
      const message = error instanceof Error ? error.message : `Unable to test ${service.displayName} key.`;
      if (previous) {
        this.postMessage({ type: "keyActionError", serviceId, message });
      } else {
        this.postMessage({
          type: "keyStatusUpdated",
          status: { ...current, message, maskedPreview: current.maskedPreview ?? maskKeyPreview(undefined) },
          focusServiceId: serviceId,
        });
      }
    }
  }

  private restoreKeyValidationState() {
    const stored =
      this.context.globalState.get<Partial<Record<KeyServiceId, PersistedKeyValidationSnapshot>>>(
        KeyManagementHandler.KEY_VALIDATION_STATE_STORAGE_KEY
      ) ?? {};
    for (const [serviceId, snapshot] of Object.entries(stored) as [KeyServiceId, PersistedKeyValidationSnapshot | undefined][]) {
      if (snapshot) {
        this.keyValidationState.set(serviceId, snapshot);
      }
    }
  }

  private async persistKeyValidationState() {
    await this.context.globalState.update(
      KeyManagementHandler.KEY_VALIDATION_STATE_STORAGE_KEY,
      Object.fromEntries(this.keyValidationState.entries())
    );
  }

  public async clearValidationState(serviceId: KeyServiceId) {
    this.keyValidationState.delete(serviceId);
    await this.persistKeyValidationState();
  }

  public async setValidationState(serviceId: KeyServiceId, snapshot: PersistedKeyValidationSnapshot) {
    this.keyValidationState.set(serviceId, snapshot);
    await this.persistKeyValidationState();
  }

  private async getValidationSnapshot(serviceId: KeyServiceId): Promise<PersistedKeyValidationSnapshot | undefined> {
    const snapshot = this.keyValidationState.get(serviceId);
    if (!snapshot) return undefined;
    const service = getKeyService(serviceId);
    const currentValue = await resolveCurrentKeyValue(service, this.context.secrets);
    if (!currentValue || snapshot.keyFingerprint !== buildKeyFingerprint(currentValue)) {
      await this.clearValidationState(serviceId);
      return undefined;
    }
    return snapshot;
  }

  private async buildKeyStatus(service: ReturnType<typeof getKeyService>): Promise<KeyStatusSummary> {
    return buildKeyStatusSummary(
      service,
      this.context.secrets,
      await this.getValidationSnapshot(service.serviceId)
    );
  }
}
