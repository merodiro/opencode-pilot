let _opencode_plugin_gui = require("@opencode/plugin/gui");
let solid_js_store = require("solid-js/store");
// rpc.ts
const JevStatus = require("@opencode/plugin/rpc").Rpc.define({
	id: "jev-router.status",
	methods: {
		get: {
			input: {
				type: "object",
				properties: { sessionID: { type: "string" } },
				additionalProperties: false
			},
			output: {
				type: "object",
				properties: { route: { oneOf: [{
					type: "object",
					properties: {
						sessionID: { type: "string" },
						model: { type: "string" },
						tier: { type: "string" },
						updated: { type: "number" }
					},
					required: [
						"sessionID",
						"model",
						"tier",
						"updated"
					],
					additionalProperties: false
				}, { type: "null" }] } },
				required: ["route"],
				additionalProperties: false
			}
		},
		decisions: {
			input: {
				type: "object",
				properties: { sessionID: { type: "string" } },
				required: ["sessionID"],
				additionalProperties: false
			},
			output: {
				type: "object",
				properties: { decisions: {
					type: "array",
					items: { type: "object" }
				} },
				required: ["decisions"],
				additionalProperties: false
			}
		}
	},
	events: { changed: { schema: {
		type: "object",
		properties: {
			sessionID: { type: "string" },
			model: { type: "string" },
			tier: { type: "string" },
			updated: { type: "number" }
		},
		required: [
			"sessionID",
			"model",
			"tier",
			"updated"
		]
	} } }
});
// gui.tsx
var gui_default = _opencode_plugin_gui.Plugin.define({
	i18n: { en: {
		"pill.label": "Jev route",
		"pill.title": "Model chosen by the Jev router"
	} },
	setup(ctx) {
		const [routes, setRoutes] = (0, solid_js_store.createStore)({});
		const load = async (sessionID) => {
			try {
				const status = await ctx.client.rpc(JevStatus).get({ sessionID });
				setRoutes(sessionID, status.data.route ?? void 0);
			} catch {}
		};
		const current = ctx.sessions.current();
		if (current) load(current.id);
		const unsubscribe = ctx.client.rpc(JevStatus).events.on("changed", (event) => {
			const route = event.data;
			setRoutes(route.sessionID, route);
		});
		(0, _opencode_plugin_gui.createKeyed)(() => ctx.sessions.current()?.id, (sessionID) => {
			if (sessionID) load(sessionID);
		});
		ctx.add(_opencode_plugin_gui.ComposerPill, {
			id: "route",
			show: (input) => {
				const route = routes[input.session.id];
				if (!route || route.tier === "manual") return void 0;
				return {
					label: `${route.tier}: ${route.model}`,
					title: ctx.t("pill.title")
				};
			}
		});
		return unsubscribe;
	}
});
module.exports = gui_default;
