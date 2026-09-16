import { ContractError } from "../worker/contracts/shared.ts";
import type { RuntimeSecrets } from "../worker/reconciliation/dependencies.ts";
import {
  decryptConfiguration,
  encryptConfiguration,
  type EncryptedEnvelope,
} from "../worker/reconciliation/crypto.ts";
import type { ApplicationStateStore } from "./application-state.ts";
import { OAuthTransport, type OAuthTokens } from "./zendesk-oauth.ts";

/** One runtime per connector remains required. No network request holds a DB transaction. */
export class CredentialCoordinator {
  private readonly uncertain = new Set<number>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly store: ApplicationStateStore,
    private readonly key: string,
    private readonly transport?: OAuthTransport,
    private readonly now = Date.now,
  ) {}
  exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action, action);
    this.tail = result.catch(() => undefined);
    return result;
  }
  async secrets(envelope: string): Promise<RuntimeSecrets> {
    return decryptConfiguration(
      JSON.parse(envelope) as EncryptedEnvelope,
      this.key,
    );
  }
  provider(account: string, revision: number) {
    return {
      get: () => this.authorization(account, revision),
      onUnauthorized: (previous: string) =>
        this.authorization(account, revision, previous),
    };
  }
  private authorization(
    account: string,
    revision: number,
    previous?: string,
  ): Promise<string> {
    return this.exclusive(async () => {
      const configuration = await this.store.configuration();
      if (!configuration || configuration.revision !== revision)
        throw new ContractError(
          "ZENDESK_AUTH_REQUIRED",
          "Zendesk configuration changed. Retry with the current configuration.",
        );
      const secrets = await this.secrets(configuration.credentialEnvelope);
      const token = secrets.zendesk as OAuthTokens;
      if (
        token.kind !== "oauth" ||
        token.accountSubdomain !== account ||
        token.health ||
        this.uncertain.has(revision) ||
        !this.transport ||
        token.clientId !== this.transport.settings.clientId
      )
        throw new ContractError(
          "ZENDESK_AUTH_REQUIRED",
          "Reconnect Zendesk before syncing.",
        );
      const header = `Bearer ${token.accessToken}`;
      if (
        token.accessExpiresAt > this.now() + 60_000 &&
        (!previous || previous !== header)
      )
        return header;
      let next: OAuthTokens;
      try {
        if (token.refreshExpiresAt <= this.now()) throw new Error("expired");
        next = await this.transport.refresh(token);
      } catch {
        this.uncertain.add(revision);
        try {
          const failed = {
            ...secrets,
            zendesk: { ...token, health: "reconnect_required" as const },
          };
          await this.store.compareAndSwapCredentials(
            revision,
            configuration.credentialEnvelope,
            JSON.stringify(await encryptConfiguration(failed, this.key)),
          );
          const scheduler = await this.store.scheduler();
          if (scheduler.state !== "disabled")
            await this.store.saveScheduler({
              state: "paused",
              retryAttempt: 0,
              pauseReason: "permanent_failure",
            });
        } catch {
          /* Storage failure does not permit reuse of uncertain tokens. */
        }
        throw new ContractError(
          "ZENDESK_AUTH_REQUIRED",
          "Zendesk renewal failed or is uncertain. Reconnect Zendesk, then resume scheduling.",
        );
      }
      try {
        const envelope = JSON.stringify(
          await encryptConfiguration({ ...secrets, zendesk: next }, this.key),
        );
        if (
          !(await this.store.compareAndSwapCredentials(
            revision,
            configuration.credentialEnvelope,
            envelope,
          ))
        )
          throw new ContractError(
            "ZENDESK_AUTH_REQUIRED",
            "Zendesk renewal could not be saved. Reconnect Zendesk.",
          );
        return `Bearer ${next.accessToken}`;
      } catch {
        this.uncertain.add(revision);
        throw new ContractError(
          "ZENDESK_AUTH_REQUIRED",
          "Zendesk renewal could not be saved. Reconnect Zendesk.",
        );
      }
    });
  }
}
