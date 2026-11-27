import { ComposerPill, Plugin, createKeyed } from "@opencode/plugin/gui";
import { createStore } from "solid-js/store";
import { JevStatus, type JevRoute } from "./rpc";

export default Plugin.define({
  i18n: {
    en: {
      "pill.label": "Jev route",
      "pill.title": "Model chosen by the Jev router",
    },
  },
  setup(ctx) {
    const [routes, setRoutes] = createStore<
      Record<string, JevRoute | undefined>
    >({});

    const load = async (sessionID: string) => {
      try {
        const status = (await ctx.client.rpc(JevStatus).get({ sessionID })) as {
          data: { route: JevRoute | null };
        };
        setRoutes(sessionID, status.data.route ?? undefined);
      } catch {
        // Server unavailable; keep the last route for this session.
      }
    };

    const current = ctx.sessions.current();
    if (current) void load(current.id);

    const unsubscribe = ctx.client
      .rpc(JevStatus)
      .events.on("changed", (event) => {
        const route = event.data as unknown as JevRoute;
        setRoutes(route.sessionID, route);
      });

    createKeyed(
      () => ctx.sessions.current()?.id,
      (sessionID) => {
        if (sessionID) void load(sessionID);
      },
    );

    ctx.add(ComposerPill, {
      id: "route",
      show: (input) => {
        const route = routes[input.session.id];
        if (!route || route.tier === "manual") return undefined;
        return {
          label: `${route.tier}: ${route.model}`,
          title: ctx.t("pill.title"),
        };
      },
    });

    return unsubscribe;
  },
});
