// Pack config for `vp pack` (Vite+ Pack, tsdown-based). Plain object on purpose:
// importing "vite-plus" would require it in node_modules, but it is
// mise-managed. `vp pack` reads the `pack` block as-is.
export default {
  pack: {
    entry: { "gui-experimental": "./gui.tsx" },
    outDir: "dist",
    format: ["cjs"],
    platform: "node",
    treeshake: true,
    deps: { neverBundle: [/^@opencode\/plugin/, /^solid-js/] },
  },
};
