import { Plugin } from "@opencode/plugin/tui";
import { createSignal } from "solid-js";

function formatModel(
  info:
    | { modelID?: string; id?: string; providerID?: string; variant?: string }
    | undefined,
): string | undefined {
  if (!info) return undefined;
  const id = info.modelID ?? info.id;
  if (!id) return undefined;
  const base = info.providerID ? `${info.providerID}/${id}` : id;
  return info.variant ? `${base}#${info.variant}` : base;
}

export default Plugin.define({
  id: "jev-router.ui",
  setup(context) {
    const [lastModel, setLastModel] = createSignal<string | undefined>();
    const seen = new Set<string>();

    const refresh = (sessionID?: string) => {
      if (!sessionID) return;
      const messages = context.data.session.message.list(sessionID);
      void context.data.session.message.sync(sessionID);
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message.type !== "assistant") continue;
        if (!seen.has(message.id)) {
          seen.add(message.id);
          const label = formatModel(message.model);
          if (label) setLastModel(label);
        }
        return;
      }
    };

    const stopStatus = context.data.on("session.status", (event) => {
      refresh(event.data.sessionID);
    });
    const stopIdle = context.data.on("session.idle", (event) => {
      refresh(event.data.sessionID);
    });
    const stopStep = context.data.on("session.step.started", (event) => {
      refresh(event.data.sessionID);
    });
    const stopModel = context.data.on("session.model.selected", () => {
      setLastModel(undefined);
    });

    const cleanupSlot = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        refresh(input.sessionID);
        const model = lastModel();
        if (!model) return null;
        return <text fg={context.theme.text.muted}>{`jev→ ${model}`}</text>;
      },
    });

    return () => {
      stopStatus();
      stopIdle();
      stopStep();
      stopModel();
      cleanupSlot();
    };
  },
});
