import { prepareProviderLogin } from "./provider-login-prepare.ts";
import { ProviderLoginSessions, createInstance } from "@ace/accounts";
import { ProviderLoginRequest, OnboardingRequest } from "@ace/protocol";
import { createPosixBackendFactory, TerminalManager } from "@ace/terminal";
import { daemonCursorInstance } from "./cursor-instance.ts";
import { cursorInstanceId } from "@ace/provider-kit/cursor-selection";
import { registerImplicitAccounts } from "../account-homes.ts";
import { Onboarding } from "../onboarding.ts";
import { join } from "node:path";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";

export async function startProviderLogin(context: ServiceContext): Promise<void> {
  const { services, options, resources, now, id, config } = context;
  if (services.accountRegistry)
    await registerImplicitAccounts(
      services.accountRegistry,
      options.accounts?.env ?? options.providerStatus?.env ?? process.env,
    );
  const manager = new TerminalManager({
    ...options.accounts?.terminal,
    dependencies: {
      backendFactory: createPosixBackendFactory(undefined, config.dataDir),
      ...options.accounts?.terminal?.dependencies,
    },
  });
  const cursorDefault = await daemonCursorInstance(context);
  if (services.accountRegistry && !services.accountRegistry.get(cursorDefault.id))
    await services.accountRegistry.register(
      createInstance({ ...cursorDefault, provider: "cursor", label: "Cursor" }),
    );
  const sessions = new ProviderLoginSessions({
    instanceKey(provider, instance) {
      return provider === "cursor"
        ? (cursorInstanceId(instance) ??
            services.accountRegistry?.selectedCursorSdk() ??
            cursorDefault.id)
        : instance === `${provider}-cli-default`
          ? "default"
          : instance;
    },
    now,
    id,
    schedule(callback, ms) {
      const timer = setTimeout(callback, ms);
      timer.unref();
      return () => clearTimeout(timer);
    },
    prepare: (target, action, signal) =>
      prepareProviderLogin(context, manager, cursorDefault, target, action, signal),
  });
  services.providerLogin = sessions;
  resources.own(async () => {
    await sessions.close();
    await manager.closeAll();
  });
  if (services.providerStatuses) {
    const onboarding = new Onboarding(
      join(config.dataDir, "onboarding.sqlite"),
      services.providerStatuses,
    );
    services.onboarding = onboarding;
    resources.own(() => onboarding.close());
  }
}
export function createProviderLoginSession(context: SocketContext): SocketService {
  let stop: (() => void) | undefined;
  let pending = 0;
  const manualTerminals = new Map<string, string>();
  return {
    authenticated() {
      const device = context.device();
      if (device && context.authorize("operate"))
        stop ??= context.options.providerLogin?.listen((owner, progress) => {
          if (owner === device && context.connected() && context.authorize("operate"))
            context.send({ type: "provider.login.progress", progress });
        });
    },
    close() {
      stop?.();
      manualTerminals.clear();
    },
    async handle(message, device) {
      const request = ProviderLoginRequest.safeParse(message);
      if (request.success) {
        const input = request.data;
        const service = context.options.providerLogin;
        const error =
          !context.authorize("operate") ||
          (input.type === "provider.login.apiKey" && !context.canSubmitSecret?.())
            ? "forbidden"
            : !service
              ? "unavailable"
              : pending >= 8
                ? "busy"
                : undefined;
        if (error || !service)
          context.send({
            type: "provider.login.result",
            requestId: input.requestId,
            result: { ok: false, error: error ?? "unavailable" },
          });
        else {
          stop ??= service.listen((owner, progress) => {
            if (owner === device && context.connected() && context.authorize("operate"))
              context.send({ type: "provider.login.progress", progress });
          });
          pending++;
          try {
            const result = await service.handle(device, input);
            if (!context.connected() || !context.authorize("operate")) return true;
            if (input.type === "provider.login.terminal" && result.result.ok) {
              const progress = result.result.progress;
              if (
                !progress.manual ||
                progress.state !== "failed" ||
                !context.options.accountManagement
              ) {
                result.result = { ok: false, error: "unavailable" };
              } else {
                const terminalId =
                  manualTerminals.get(progress.session) ??
                  context.options.accountManagement.openProviderTerminal(
                    context.sessionId,
                    progress.instance ?? `${progress.provider}-cli-default`,
                    progress.action,
                  );
                if (!manualTerminals.has(progress.session) && manualTerminals.size >= 32) {
                  const oldest = manualTerminals.keys().next().value;
                  if (oldest) manualTerminals.delete(oldest);
                }
                manualTerminals.set(progress.session, terminalId);
                progress.manual.terminalId = terminalId;
              }
            }
            if (context.connected() && context.authorize("operate")) context.send(result);
          } catch {
            if (context.connected() && context.authorize("operate"))
              context.send({
                type: "provider.login.result",
                requestId: input.requestId,
                result: { ok: false, error: "unavailable" },
              });
          } finally {
            if (input.type === "provider.login.apiKey") {
              input.apiKey = "";
              if (message.type === "provider.login.apiKey") message.apiKey = "";
            }
            pending--;
          }
        }
        if (input.type === "provider.login.apiKey") {
          input.apiKey = "";
          if (message.type === "provider.login.apiKey") message.apiKey = "";
        }
        return true;
      }
      const onboarding = OnboardingRequest.safeParse(message);
      if (!onboarding.success) return false;
      const input = onboarding.data;
      const service = context.options.onboarding;
      if (!context.authorize(input.type === "onboarding.dismiss" ? "operate" : "read"))
        context.send({
          type: "onboarding.result",
          requestId: input.requestId,
          result: { ok: false, error: "forbidden" },
        });
      else if (!service)
        context.send({
          type: "onboarding.result",
          requestId: input.requestId,
          result: { ok: false, error: "unavailable" },
        });
      else {
        try {
          if (input.type === "onboarding.dismiss") service.dismiss(device, input.dismissed);
          context.send(service.query(device, input.requestId));
        } catch {
          context.send({
            type: "onboarding.result",
            requestId: input.requestId,
            result: { ok: false, error: "unavailable" },
          });
        }
      }
      return true;
    },
  };
}
